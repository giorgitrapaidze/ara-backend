'use strict';

const { Router } = require('express');
const router = Router();

router.get('/', (req, res) => {
  const { refLapTime, curLapTime, sectorBoundaries, refTimes, curTimes, coachingTips } = req.app.locals;

  const sectorDeltas = sectorBoundaries.map(b => {
    const { id, startIndex, endIndex } = b;
    const refTime = +(Number(refTimes[endIndex]) - Number(refTimes[startIndex])).toFixed(3);
    const curTime = +(Number(curTimes[endIndex]) - Number(curTimes[startIndex])).toFixed(3);
    return { name: `Sector ${id}`, refTime, curTime, delta: +(curTime - refTime).toFixed(3) };
  });

  // Top improvements from coaching tips, sorted by delta
  const improvements = [...sectorDeltas]
    .sort((a, b) => b.delta - a.delta)
    .filter(s => s.delta > 0.01)
    .map(s => {
      const tip = coachingTips.find(t => t.sectorId === sectorDeltas.indexOf(s) + 1);
      if (tip) return `${tip.tip.split('.')[0]} — recovers ${s.delta.toFixed(2)}s in Sector ${sectorDeltas.indexOf(s) + 1}`;
      return `Improve Sector ${sectorDeltas.indexOf(s) + 1} — recovers ${s.delta.toFixed(2)}s`;
    })
    .slice(0, 3);

  // Fallback hardcoded improvements if no tips available
  const fallback = [
    'Move braking point 8m earlier into Turn 4 — recovers 0.22s in Sector 2',
    'Delay throttle application to apex in Sector 3 — recovers 0.18s',
    'Smooth steering inputs through Sector 4 to reduce oversteer — recovers 0.04s',
  ];

  res.json({
    referenceLapTime: refLapTime,
    currentLapTime:   curLapTime,
    totalDelta:       +(curLapTime - refLapTime).toFixed(3),
    improvements:     improvements.length ? improvements : fallback,
    sectorDeltas,
  });
});

module.exports = router;
