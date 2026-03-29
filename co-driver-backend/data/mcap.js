'use strict';

const fs   = require('fs');
const path = require('path');
const { McapWriter } = require('@mcap/core');

// ── Canvas (optional — fall back to placeholder JPEG if missing) ──────────────

let createCanvas;
try {
  ({ createCanvas } = require('canvas'));
} catch (_) {
  createCanvas = null;
}

// 1×1 black JPEG as base64 placeholder
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC' +
  'AABAAEDASIA' + 'AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAA' +
  'AAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/a' +
  'AAwDAQACEQMRAD8AJQAB/9k=', 'base64'
);

function makeCameraFrame(row, isRef) {
  if (!createCanvas) return PLACEHOLDER_JPEG;

  try {
    const W = 640, H = 360;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0A0A0A';
    ctx.fillRect(0, 0, W, H);

    // Speed — large center
    ctx.fillStyle = '#FFFFFF';
    ctx.font      = 'bold 96px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(row.speed)}`, W / 2, H / 2 + 30);

    ctx.font      = '18px monospace';
    ctx.fillText('km/h', W / 2, H / 2 + 58);

    // CO-DRIVER watermark
    ctx.font      = '14px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('CO-DRIVER', 12, 22);

    // Sector indicator top-right
    ctx.textAlign = 'right';
    ctx.fillText(`S${row.sector}`, W - 12, 22);

    // Gear bottom-left
    ctx.font      = '28px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText(`G${row.gear}`, 12, H - 40);

    // Throttle bar (green)
    ctx.fillStyle = '#22C55E';
    ctx.fillRect(12, H - 20, row.throttle * 200, 10);

    // Brake bar (red)
    ctx.fillStyle = '#EF4444';
    ctx.fillRect(12, H - 8, row.brake * 200, 8);

    // Pace indicator bar — bottom strip
    ctx.fillStyle = isRef ? '#22C55E' : (row.brake > 0.1 ? '#EF4444' : '#F59E0B');
    ctx.fillRect(0, H - 3, W, 3);

    return canvas.toBuffer('image/jpeg', { quality: 0.7 });
  } catch (_) {
    return PLACEHOLDER_JPEG;
  }
}

// ── FileWritable ───────────────────────────────────────────────────────────────

class FileWritable {
  constructor(filePath) {
    this.fd   = fs.openSync(filePath, 'w');
    this._pos = 0n;
  }
  async write(buf) {
    fs.writeSync(this.fd, buf);
    this._pos += BigInt(buf.byteLength);
  }
  position() { return this._pos; }
  close()    { fs.closeSync(this.fd); }
}

// ── Schema helpers ─────────────────────────────────────────────────────────────

function jsonSchema(name, props) {
  return {
    name,
    encoding: 'jsonschema',
    data: Buffer.from(JSON.stringify({
      title: name,
      type: 'object',
      properties: props,
    }), 'utf8'),
  };
}

// ── Write one MCAP file ────────────────────────────────────────────────────────

async function writeMcap(rows, filePath, isRef) {
  const fw     = new FileWritable(filePath);
  const writer = new McapWriter({ writable: fw });
  await writer.start({ library: 'co-driver', profile: '' });

  const schemas = {
    pose:       await writer.registerSchema(jsonSchema('car/Pose',
      { x:{type:'number'}, y:{type:'number'}, z:{type:'number'}, yaw:{type:'number'}, timestamp:{type:'number'} })),
    velocity:   await writer.registerSchema(jsonSchema('car/Velocity',
      { vx:{type:'number'}, vy:{type:'number'}, speed:{type:'number'}, timestamp:{type:'number'} })),
    inputs:     await writer.registerSchema(jsonSchema('car/Inputs',
      { throttle:{type:'number'}, brake:{type:'number'}, clutch:{type:'number'}, steering:{type:'number'}, timestamp:{type:'number'} })),
    tyres:      await writer.registerSchema(jsonSchema('car/Tyres',
      { slipRatioFL:{type:'number'}, slipRatioFR:{type:'number'}, slipRatioRL:{type:'number'}, slipRatioRR:{type:'number'},
        slipAngleFL:{type:'number'}, slipAngleFR:{type:'number'}, slipAngleRL:{type:'number'}, slipAngleRR:{type:'number'},
        tempFL:{type:'number'}, tempFR:{type:'number'}, tempRL:{type:'number'}, tempRR:{type:'number'},
        pressureFL:{type:'number'}, pressureFR:{type:'number'}, pressureRL:{type:'number'}, pressureRR:{type:'number'},
        timestamp:{type:'number'} })),
    suspension: await writer.registerSchema(jsonSchema('car/Suspension',
      { loadFL:{type:'number'}, loadFR:{type:'number'}, loadRL:{type:'number'}, loadRR:{type:'number'},
        travelFL:{type:'number'}, travelFR:{type:'number'}, travelRL:{type:'number'}, travelRR:{type:'number'},
        timestamp:{type:'number'} })),
    engine:     await writer.registerSchema(jsonSchema('car/Engine',
      { rpm:{type:'number'}, gear:{type:'number'}, timestamp:{type:'number'} })),
    brakes:     await writer.registerSchema(jsonSchema('car/Brakes',
      { discTempFL:{type:'number'}, discTempFR:{type:'number'}, discTempRL:{type:'number'}, discTempRR:{type:'number'}, timestamp:{type:'number'} })),
    camera:     await writer.registerSchema({
      name: 'foxglove.CompressedImage',
      encoding: 'jsonschema',
      data: Buffer.from(JSON.stringify({
        title: 'foxglove.CompressedImage',
        type: 'object',
        properties: {
          timestamp: { type: 'object', properties: { sec: {type:'integer'}, nsec: {type:'integer'} } },
          frame_id: { type: 'string' },
          data:     { type: 'string' },
          format:   { type: 'string' },
        },
      }), 'utf8'),
    }),
  };

  const channels = {
    pose:       await writer.registerChannel({ topic: '/car/pose',       messageEncoding: 'json', schemaId: schemas.pose,       metadata: new Map() }),
    velocity:   await writer.registerChannel({ topic: '/car/velocity',   messageEncoding: 'json', schemaId: schemas.velocity,   metadata: new Map() }),
    inputs:     await writer.registerChannel({ topic: '/car/inputs',     messageEncoding: 'json', schemaId: schemas.inputs,     metadata: new Map() }),
    tyres:      await writer.registerChannel({ topic: '/car/tyres',      messageEncoding: 'json', schemaId: schemas.tyres,      metadata: new Map() }),
    suspension: await writer.registerChannel({ topic: '/car/suspension', messageEncoding: 'json', schemaId: schemas.suspension, metadata: new Map() }),
    engine:     await writer.registerChannel({ topic: '/car/engine',     messageEncoding: 'json', schemaId: schemas.engine,     metadata: new Map() }),
    brakes:     await writer.registerChannel({ topic: '/car/brakes',     messageEncoding: 'json', schemaId: schemas.brakes,     metadata: new Map() }),
    camera:     await writer.registerChannel({ topic: '/car/camera',     messageEncoding: 'json', schemaId: schemas.camera,     metadata: new Map() }),
  };

  let seq = 0;

  for (const row of rows) {
    const ns = row.timestamp; // already BigInt
    const ts = Number(ns);

    const msg = async (channelId, data) => {
      await writer.addMessage({
        channelId,
        sequence:    seq++,
        logTime:     ns,
        publishTime: ns,
        data:        Buffer.from(JSON.stringify(data), 'utf8'),
      });
    };

    await msg(channels.pose, { x: row.x, y: row.y, z: row.z, yaw: row.yaw, timestamp: ts });
    await msg(channels.velocity, { vx: row.vx, vy: row.vy, speed: row.speed, timestamp: ts });
    await msg(channels.inputs, { throttle: row.throttle, brake: row.brake, clutch: row.clutch, steering: row.steering, timestamp: ts });
    await msg(channels.tyres, {
      slipRatioFL: row.slipRatioFL, slipRatioFR: row.slipRatioFR, slipRatioRL: row.slipRatioRL, slipRatioRR: row.slipRatioRR,
      slipAngleFL: row.slipAngleFL, slipAngleFR: row.slipAngleFR, slipAngleRL: row.slipAngleRL, slipAngleRR: row.slipAngleRR,
      tempFL: row.tempFL, tempFR: row.tempFR, tempRL: row.tempRL, tempRR: row.tempRR,
      pressureFL: row.pressureFL, pressureFR: row.pressureFR, pressureRL: row.pressureRL, pressureRR: row.pressureRR,
      timestamp: ts,
    });
    await msg(channels.suspension, {
      loadFL: row.loadFL, loadFR: row.loadFR, loadRL: row.loadRL, loadRR: row.loadRR,
      travelFL: row.travelFL, travelFR: row.travelFR, travelRL: row.travelRL, travelRR: row.travelRR,
      timestamp: ts,
    });
    await msg(channels.engine, { rpm: row.rpm, gear: row.gear, timestamp: ts });
    await msg(channels.brakes, {
      discTempFL: row.discTempFL, discTempFR: row.discTempFR,
      discTempRL: row.discTempRL, discTempRR: row.discTempRR,
      timestamp: ts,
    });

    // Camera at 10 Hz (every 6th frame)
    if (row.index % 6 === 0) {
      const jpegBuf = makeCameraFrame(row, isRef);
      const sec  = Math.floor(Number(ns) / 1e9);
      const nsec = Number(ns) % 1e9;
      await msg(channels.camera, {
        timestamp: { sec, nsec },
        frame_id:  'camera',
        data:      jpegBuf.toString('base64'),
        format:    'jpeg',
      });
    }
  }

  await writer.end();
  fw.close();
}

module.exports = { writeMcap };
