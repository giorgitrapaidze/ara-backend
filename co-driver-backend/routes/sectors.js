'use strict';

const { Router } = require('express');
const router = Router();

router.get('/', (req, res) => {
  const { reference, current, sectorBoundaries, refTimes, curTimes } = req.app.locals;

  const sectors = sectorBoundaries.map(b => {
    const { id, startIndex, endIndex } = b;

    const refStart = Number(refTimes[startIndex]);
    const refEnd   = Number(refTimes[endIndex]);
    const curStart = Number(curTimes[startIndex]);
    const curEnd   = Number(curTimes[endIndex]);

    const refTime = +(refEnd - refStart).toFixed(3);
    const curTime = +(curEnd - curStart).toFixed(3);
    const delta   = +(curTime - refTime).toFixed(3);

    let status = 'similar';
    if      (delta >  0.05) status = 'slower';
    else if (delta < -0.05) status = 'faster';

    return {
      id,
      name:          `Sector ${id}`,
      refTime,
      curTime,
      delta,
      status,
      startDistance: +reference[startIndex].distance.toFixed(1),
      endDistance:   +reference[endIndex].distance.toFixed(1),
      startIndex,
      endIndex,
    };
  });

  res.json(sectors);
});

module.exports = router;
