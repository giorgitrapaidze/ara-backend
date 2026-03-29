'use strict';

const { Router } = require('express');
const path   = require('path');
const fs     = require('fs');
const router = Router();

const VIDEO_PATH = path.join(__dirname, '..', 'session.mp4');

router.get('/', (req, res) => {
  if (!fs.existsSync(VIDEO_PATH)) {
    return res.status(404).json({
      error: 'No video file found. Drop session.mp4 into the project root.',
    });
  }
  // Express handles range requests (video seeking) automatically via sendFile
  res.sendFile(VIDEO_PATH);
});

module.exports = router;
