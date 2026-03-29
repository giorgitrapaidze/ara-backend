'use strict';

const { Router } = require('express');
const router = Router();

router.get('/', (req, res) => {
  const { reference, current, refLapTime, curLapTime } = req.app.locals;

  // Slim down to the fields the spec requires for the JSON response
  const slim = rows => rows.map(r => ({
    index:     r.index,
    timestamp: Number(r.timestamp),
    distance:  r.distance,
    x: r.x, y: r.y, z: r.z, yaw: r.yaw,
    speed:    r.speed,
    throttle: r.throttle,
    brake:    r.brake,
    steering: r.steering,
    rpm:      r.rpm,
    gear:     r.gear,
    sector:   r.sector,
  }));

  res.json({
    videoOffsetSeconds: 0,
    referenceLapTime:   refLapTime,
    currentLapTime:     curLapTime,
    delta:              +(curLapTime - refLapTime).toFixed(3),
    reference:          slim(reference),
    current:            slim(current),
  });
});

module.exports = router;
