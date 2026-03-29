'use strict';

const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');

const NPY_FAST = path.join(__dirname, '../../hachathon_fast_laps.npy');
const NPY_GOOD = path.join(__dirname, '../../hachathon_good_laps.npy');

const N           = 5400;
const SECTOR_SIZE = N / 5;
const TWO_PI      = 2 * Math.PI;

// ── Load NPY via Python subprocess ────────────────────────────────────────────

const PY_SCRIPT = `
import numpy as np, json, sys
data = np.load(sys.argv[1])
print(json.dumps({
  'x':     data[:,0].tolist(),
  'y':     data[:,1].tolist(),
  'v':     data[:,2].tolist(),
  'gas':   data[:,3].tolist(),
  'brake': data[:,4].tolist(),
}))
`;

function loadNpy(npyPath) {
  const scriptPath = '/tmp/_co_driver_npy.py';
  fs.writeFileSync(scriptPath, PY_SCRIPT);
  const out = execSync(`python3 ${scriptPath} "${npyPath}"`, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.toString());
}

// ── Arc-length resampling ─────────────────────────────────────────────────────

function resample(data) {
  const { x, y, v, gas, brake } = data;
  const M = x.length;

  // Cumulative arc length
  const arcLen = new Float64Array(M);
  for (let i = 1; i < M; i++) {
    const dx = x[i] - x[i - 1];
    const dy = y[i] - y[i - 1];
    arcLen[i] = arcLen[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const totalLen = arcLen[M - 1];

  const ox    = new Float64Array(N);
  const oy    = new Float64Array(N);
  const ov    = new Float64Array(N); // km/h
  const ogas  = new Float64Array(N);
  const obrk  = new Float64Array(N);
  const odist = new Float64Array(N);

  let j = 0;
  for (let i = 0; i < N; i++) {
    const s = (i / (N - 1)) * totalLen;
    odist[i] = s;

    while (j < M - 2 && arcLen[j + 1] < s) j++;
    const span = arcLen[j + 1] - arcLen[j];
    const t    = span > 0 ? (s - arcLen[j]) / span : 0;

    ox[i]   = x[j]   + t * (x[j + 1]   - x[j]);
    oy[i]   = y[j]   + t * (y[j + 1]   - y[j]);
    ov[i]   = (v[j]   + t * (v[j + 1]   - v[j])) * 3.6;   // m/s → km/h
    ogas[i] = gas[j]  + t * (gas[j + 1]  - gas[j]);
    obrk[i] = brake[j] + t * (brake[j + 1] - brake[j]);
  }

  return { x: ox, y: oy, v: ov, gas: ogas, brake: obrk, dist: odist };
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function computeYaw(x, y) {
  const yaw = new Float64Array(N);
  const W   = 5;
  for (let i = 0; i < N; i++) {
    const i0 = Math.max(0, i - W);
    const i1 = Math.min(N - 1, i + W);
    yaw[i] = Math.atan2(y[i1] - y[i0], x[i1] - x[i0]);
  }
  return yaw;
}

function computeCurvature(x, y) {
  const curv = new Float64Array(N);
  for (let i = 1; i < N - 1; i++) {
    const ax = x[i - 1], ay = y[i - 1];
    const bx = x[i],     by = y[i];
    const cx = x[i + 1], cy = y[i + 1];
    const cross  = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const lab    = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const lbc    = Math.sqrt((cx - bx) ** 2 + (cy - by) ** 2);
    const lac    = Math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2);
    const denom  = lab * lbc * lac;
    curv[i] = denom > 1e-6 ? Math.abs(cross) / denom : 0;
  }
  curv[0]     = curv[1];
  curv[N - 1] = curv[N - 2];
  return curv;
}

function buildTimestamps(dist, speedKmh) {
  const times = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const ds = dist[i] - dist[i - 1];
    const v  = Math.max(speedKmh[i - 1] / 3.6, 0.5); // guard divide-by-zero
    times[i] = times[i - 1] + ds / v;
  }
  return times;
}

// ── Full row builder (same schema as generate.js) ─────────────────────────────

function buildRows(rs) {
  const { x, y, v: speedKmh, gas, brake: brakeArr, dist } = rs;

  const yaw   = computeYaw(x, y);
  const curv  = computeCurvature(x, y);
  const times = buildTimestamps(dist, speedKmh);

  const rows     = [];
  let tyreTemp   = [85, 85, 85, 85];
  let brakeTemp  = [200, 200, 150, 150];
  let prevSpeed  = speedKmh[0];

  for (let i = 0; i < N; i++) {
    const spd   = speedKmh[i];
    const spdMs = spd / 3.6;
    const t     = times[i];

    // Gear
    let gear;
    if      (spd < 60)  gear = 1;
    else if (spd < 90)  gear = 2;
    else if (spd < 120) gear = 3;
    else if (spd < 150) gear = 4;
    else if (spd < 180) gear = 5;
    else if (spd < 210) gear = 6;
    else                gear = 7;

    const gearRatio = [0, 3.5, 2.5, 1.9, 1.5, 1.25, 1.1, 0.92][gear];
    const rpm = Math.round(Math.min(12000, Math.max(4000,
      (spdMs / (2 * Math.PI * 0.305)) * gearRatio * 3.73 * 60
    )));

    // Steering from yaw rate
    let dyaw = yaw[(i + 1) % N] - yaw[i];
    if (dyaw >  Math.PI) dyaw -= TWO_PI;
    if (dyaw < -Math.PI) dyaw += TWO_PI;
    const steering = Math.max(-1, Math.min(1, dyaw * 20));

    const vx   = spdMs * Math.cos(yaw[i]);
    const vy   = spdMs * Math.sin(yaw[i]);
    const latG = curv[i] * spdMs * spdMs / 9.81;
    const dt   = t - (i > 0 ? times[i - 1] : 0);
    const lonG = dt > 0 ? ((spd - prevSpeed) / 3.6) / (9.81 * dt) : 0;
    prevSpeed  = spd;

    const throttle = gas[i];
    const brakeVal = brakeArr[i];

    // Slip ratios
    const srf = Math.abs(steering) * 0.08 + brakeVal * 0.12 + Math.random() * 0.01;
    const srr = srf * 1.2 + throttle * 0.06 + Math.random() * 0.01;

    const saFront = Math.atan(latG * 0.4) * (180 / Math.PI);
    const saRear  = Math.atan(latG * 0.3) * (180 / Math.PI);

    // Tyre temps
    const hF = (Math.abs(latG) * 1.4 + brakeVal * 3.5) / 60;
    const hR = (Math.abs(latG) * 1.4 + throttle * 2.5) / 60;
    const cR = 0.8 / 60;
    tyreTemp[0] = Math.max(80, Math.min(115, tyreTemp[0] + hF - cR));
    tyreTemp[1] = Math.max(80, Math.min(115, tyreTemp[1] + hF - cR));
    tyreTemp[2] = Math.max(80, Math.min(115, tyreTemp[2] + hR - cR));
    tyreTemp[3] = Math.max(80, Math.min(115, tyreTemp[3] + hR - cR));

    const psi = [27.5, 27.5, 28.0, 28.0].map((p, k) => p + (tyreTemp[k] - 90) * 0.02);

    // Wheel loads
    const BASE = 1600;
    const dLat = latG * 480;
    const dLon = lonG * 320;
    const loads = [
      Math.max(100, BASE - dLat + dLon),
      Math.max(100, BASE + dLat + dLon),
      Math.max(100, BASE - dLat - dLon),
      Math.max(100, BASE + dLat - dLon),
    ];

    const springK  = 60;
    const travels  = loads.map(l => Math.max(0, Math.min(50, 25 + (l - BASE) / springK)));

    // Brake disc temps
    const bH = brakeVal * 900;
    const bC = 80;
    brakeTemp[0] = Math.max(200, Math.min(650, brakeTemp[0] + (bH - bC) / 60));
    brakeTemp[1] = Math.max(200, Math.min(650, brakeTemp[1] + (bH - bC) / 60));
    brakeTemp[2] = Math.max(150, Math.min(500, brakeTemp[2] + (bH * 0.6 - bC) / 60));
    brakeTemp[3] = Math.max(150, Math.min(500, brakeTemp[3] + (bH * 0.6 - bC) / 60));

    const sector = Math.min(5, Math.floor(i / SECTOR_SIZE) + 1);

    rows.push({
      index:     i,
      timestamp: BigInt(Math.round(t * 1e9)),
      distance:  +dist[i].toFixed(2),
      x: +x[i].toFixed(3), y: +y[i].toFixed(3), z: 0,
      yaw: +yaw[i].toFixed(5),
      vx: +vx.toFixed(3), vy: +vy.toFixed(3),
      speed:    +spd.toFixed(2),
      throttle: +throttle.toFixed(3),
      brake:    +brakeVal.toFixed(3),
      clutch:   0,
      steering: +steering.toFixed(4),
      rpm, gear, sector,
      slipRatioFL: +srf.toFixed(4), slipRatioFR: +srf.toFixed(4),
      slipRatioRL: +srr.toFixed(4), slipRatioRR: +srr.toFixed(4),
      slipAngleFL: +saFront.toFixed(3), slipAngleFR: +saFront.toFixed(3),
      slipAngleRL: +saRear.toFixed(3),  slipAngleRR: +saRear.toFixed(3),
      tempFL: +tyreTemp[0].toFixed(1), tempFR: +tyreTemp[1].toFixed(1),
      tempRL: +tyreTemp[2].toFixed(1), tempRR: +tyreTemp[3].toFixed(1),
      pressureFL: +psi[0].toFixed(2), pressureFR: +psi[1].toFixed(2),
      pressureRL: +psi[2].toFixed(2), pressureRR: +psi[3].toFixed(2),
      loadFL: Math.round(loads[0]), loadFR: Math.round(loads[1]),
      loadRL: Math.round(loads[2]), loadRR: Math.round(loads[3]),
      travelFL: +travels[0].toFixed(2), travelFR: +travels[1].toFixed(2),
      travelRL: +travels[2].toFixed(2), travelRR: +travels[3].toFixed(2),
      discTempFL: Math.round(brakeTemp[0]), discTempFR: Math.round(brakeTemp[1]),
      discTempRL: Math.round(brakeTemp[2]), discTempRR: Math.round(brakeTemp[3]),
    });
  }

  return { rows, times };
}

// ── Sector boundaries ─────────────────────────────────────────────────────────

function sectorBoundaries() {
  const bounds = [];
  for (let s = 0; s < 5; s++) {
    bounds.push({ id: s + 1, startIndex: s * SECTOR_SIZE, endIndex: (s + 1) * SECTOR_SIZE - 1 });
  }
  return bounds;
}

// ── Main export ───────────────────────────────────────────────────────────────

function loadRealLaps() {
  if (!fs.existsSync(NPY_FAST)) throw new Error(`Missing: ${NPY_FAST}`);
  if (!fs.existsSync(NPY_GOOD)) throw new Error(`Missing: ${NPY_GOOD}`);

  console.log('  [REAL DATA] Loading hackathon NPY files…');
  const fastRaw  = loadNpy(NPY_FAST);   // fast_laps  → reference
  const goodRaw  = loadNpy(NPY_GOOD);   // good_lap   → current

  console.log(`  Resampling: fast=${fastRaw.x.length}pts → ${N}, good=${goodRaw.x.length}pts → ${N}`);
  const fastRs = resample(fastRaw);
  const goodRs = resample(goodRaw);

  console.log('  Building telemetry rows…');
  const { rows: reference, times: refTimes } = buildRows(fastRs);
  const { rows: current,   times: curTimes } = buildRows(goodRs);

  const bounds     = sectorBoundaries();
  const refLapTime = +refTimes[N - 1].toFixed(3);
  const curLapTime = +curTimes[N - 1].toFixed(3);

  console.log(`  Real lap times: REF ${refLapTime}s  CUR ${curLapTime}s  Δ ${(curLapTime - refLapTime).toFixed(3)}s`);

  return { reference, current, sectorBoundaries: bounds, refLapTime, curLapTime, refTimes, curTimes };
}

module.exports = { loadRealLaps };
