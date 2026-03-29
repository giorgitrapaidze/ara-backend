'use strict';

const fs     = require('fs');
const path   = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { McapIndexedReader } = require('@mcap/core');

// ── IReadable backed by a file descriptor ─────────────────────────────────────

function makeReadable(mcapPath) {
  const fd = fs.openSync(mcapPath, 'r');
  return {
    async read(offset, size) {
      const n   = Number(size);
      const off = Number(offset);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, off);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async size() {
      return BigInt(fs.fstatSync(fd).size);
    },
    close() { fs.closeSync(fd); },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function extractVideoFromMcap(mcapPath, outputPath) {
  // ── Step 1: read all /car/camera messages ───────────────────────────────────
  const readable = makeReadable(mcapPath);
  const reader   = await McapIndexedReader.Initialize({ readable });

  const frames = [];
  for await (const msg of reader.readMessages({ topics: ['/car/camera'] })) {
    const parsed = JSON.parse(Buffer.from(msg.data).toString('utf8'));
    frames.push({
      buffer:    Buffer.from(parsed.data, 'base64'),
      timestamp: Number(msg.logTime) / 1e9, // ns → seconds
    });
  }
  readable.close();

  if (frames.length === 0) throw new Error('No camera frames found in MCAP');

  // ── Step 2: write JPEG frames to a temp directory ───────────────────────────
  const tempDir = path.join(path.dirname(outputPath), '.tmp_frames');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // Clear any leftover frames
  for (const f of fs.readdirSync(tempDir)) fs.unlinkSync(path.join(tempDir, f));

  for (let i = 0; i < frames.length; i++) {
    fs.writeFileSync(
      path.join(tempDir, `frame_${String(i).padStart(6, '0')}.jpg`),
      frames[i].buffer,
    );
  }

  // ── Step 3: calculate framerate from timestamps ──────────────────────────────
  const duration = frames[frames.length - 1].timestamp - frames[0].timestamp;
  const fps      = duration > 0 ? Math.round(frames.length / duration) : 10;

  // ── Step 4: ffmpeg encode ────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(tempDir, 'frame_%06d.jpg'))
      .inputOptions([`-framerate ${fps}`])
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-crf 23',
        '-movflags +faststart',  // essential for browser video seeking
      ])
      .output(outputPath)
      .on('end', () => {
        // Clean up temp frames
        try {
          for (const f of fs.readdirSync(tempDir)) fs.unlinkSync(path.join(tempDir, f));
          fs.rmdirSync(tempDir);
        } catch (_) {}
        resolve(outputPath);
      })
      .on('error', (err) => {
        // Surface a clear message if ffmpeg binary is missing
        const msg = err.message.includes('ENOENT') || err.message.includes('Cannot find ffmpeg')
          ? 'ffmpeg not found on PATH. Install: apt install ffmpeg / brew install ffmpeg'
          : err.message;
        reject(new Error(msg));
      })
      .run();
  });
}

module.exports = { extractVideoFromMcap };
