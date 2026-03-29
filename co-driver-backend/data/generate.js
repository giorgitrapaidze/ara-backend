'use strict';

const N            = 5400;       // 60 Hz × 90 s
const TWO_PI       = 2 * Math.PI;
const SECTOR_SIZE  = N / 5;      // 1080 points per sector
const TRACK_LEN_M  = 3479;       // target circuit length in metres
const REF_LAP_TIME = 89.441;     // seconds
const CUR_LAP_TIME = 89.881;     // seconds

// ── Parametric path ──────────────────────────────────────────────────────────

function buildPath() {
  const pts = [];
  let cumDist = 0;

  for (let i = 0; i < N; i++) {
    const t = (i / N) * TWO_PI;

    const x  = 200*Math.sin(t)  + 80*Math.sin(2*t)  + 40*Math.sin(3*t);
    const y  = 150*Math.cos(t)  + 60*Math.cos(2*t)  + 20*Math.cos(3*t);
    const dx =  200*Math.cos(t) + 160*Math.cos(2*t) + 120*Math.cos(3*t);
    const dy = -150*Math.sin(t) - 120*Math.sin(2*t) -  60*Math.sin(3*t);
    const ddx = -200*Math.sin(t) - 320*Math.sin(2*t) - 360*Math.sin(3*t);
    const ddy = -150*Math.cos(t) - 240*Math.cos(2*t) - 180*Math.cos(3*t);

    const ds2       = dx*dx + dy*dy;
    const curvature = Math.abs(dx*ddy - dy*ddx) / Math.pow(ds2, 1.5);
    const yaw       = Math.atan2(dy, dx);

    if (i > 0) {
      const p = pts[i - 1];
      cumDist += Math.sqrt((x - p.x_raw)**2 + (y - p.y_raw)**2);
    }

    pts.push({ x_raw: x, y_raw: y, yaw, curvature, dist_raw: cumDist });
  }

  // Scale distances to realistic metres, keep x/y in raw units for visualisation
  const distScale = TRACK_LEN_M / cumDist;
  for (const p of pts) {
    p.dist = p.dist_raw * distScale;
    p.x    = p.x_raw;   // Foxglove-friendly, ~±300 units
    p.y    = p.y_raw;
    p.curvatureM = p.curvature / distScale; // 1/m
  }

  return pts;
}

// ── Speed profile ─────────────────────────────────────────────────────────────

function buildSpeeds(pts) {
  const curvs = pts.map(p => p.curvatureM);
  const maxC  = Math.max(...curvs);

  // Map curvature → speed with smoothstep
  const raw = curvs.map(c => {
    const n  = Math.min(c / maxC, 1);
    const s  = n * n * (3 - 2 * n); // smoothstep
    return 80 + (1 - s) * (180 - 80);
  });

  // Moving-average smoothing to remove sharp transitions
  const w   = 50;
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = -w; j <= w; j++) {
      sum += raw[(i + j + N) % N];
    }
    out[i] = sum / (2 * w + 1);
  }
  return out;
}

// ── Physics timestamps ────────────────────────────────────────────────────────

function buildTimestamps(pts, speeds) {
  const times = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const ds = pts[i].dist - pts[i - 1].dist; // metres
    const v  = speeds[i - 1] / 3.6;           // m/s
    times[i] = times[i - 1] + ds / v;
  }
  return times;
}

function scaleSpeedsToLapTime(pts, speeds, targetTime) {
  const rawTimes = buildTimestamps(pts, speeds);
  const rawTotal = rawTimes[N - 1];
  const scale    = rawTotal / targetTime; // if car goes faster, scale > 1 means reduce speed? No:
  // rawTotal is time; if rawTotal > targetTime, car is too slow → need higher speeds → multiply by (rawTotal/targetTime)
  const scaled = speeds.map(s => s * (rawTotal / targetTime));
  return { speeds: scaled, times: buildTimestamps(pts, scaled) };
}

// ── Throttle, brake, steering ────────────────────────────────────────────────

function buildInputs(pts, speeds) {
  const throttle = new Float64Array(N);
  const brake    = new Float64Array(N);
  const steering = new Float64Array(N);

  const maxC = Math.max(...pts.map(p => p.curvatureM));

  for (let i = 0; i < N; i++) {
    const curv = pts[i].curvatureM;
    const curvN = Math.min(curv / maxC, 1);

    // Speed delta (look-ahead 5 points for brake/throttle intent)
    const vNow  = speeds[i];
    const vNext = speeds[(i + 5) % N];
    const dv    = vNext - vNow;

    if (dv > 1) {
      // Accelerating
      throttle[i] = Math.min(0.85 + (1 - curvN) * 0.15, 1.0);
      brake[i]    = 0;
    } else if (dv < -2) {
      // Braking
      throttle[i] = 0;
      brake[i]    = Math.min(Math.abs(dv) / 30, 0.9);
    } else {
      // Cornering / coasting
      throttle[i] = Math.max(0.1, 0.5 - curvN * 0.4);
      brake[i]    = 0;
    }

    // Steering ∝ curvature, sign from yaw change
    const yawNext = pts[(i + 1) % N].yaw;
    const yawNow  = pts[i].yaw;
    let dyaw = yawNext - yawNow;
    if (dyaw >  Math.PI) dyaw -= TWO_PI;
    if (dyaw < -Math.PI) dyaw += TWO_PI;
    steering[i] = Math.max(-1, Math.min(1, dyaw * 20));
  }

  return { throttle, brake, steering };
}

// ── Derived channels ─────────────────────────────────────────────────────────

function buildDerived(pts, speeds, inputs, times) {
  const { throttle, brake, steering } = inputs;
  const rows = [];

  let tyreTemp    = [85, 85, 85, 85];  // FL FR RL RR °C
  let brakeTemp   = [200, 200, 150, 150]; // FL FR RL RR °C
  let prevSpeed   = speeds[0];

  for (let i = 0; i < N; i++) {
    const spd  = speeds[i];
    const spdMs = spd / 3.6;
    const t    = times[i];

    // Gear
    let gear;
    if      (spd < 60)  gear = 1;
    else if (spd < 90)  gear = 2;
    else if (spd < 120) gear = 3;
    else if (spd < 150) gear = 4;
    else if (spd < 180) gear = 5;
    else if (spd < 210) gear = 6;
    else                gear = 7;

    // RPM (simplified: proportional to speed within gear band)
    const gearRatio = [0, 3.5, 2.5, 1.9, 1.5, 1.25, 1.1, 0.92][gear];
    const rpm = Math.round(Math.min(12000, Math.max(4000,
      (spdMs / (2 * Math.PI * 0.305)) * gearRatio * 3.73 * 60
    )));

    // Velocity components
    const vx = spdMs * Math.cos(pts[i].yaw);
    const vy = spdMs * Math.sin(pts[i].yaw);

    // Lateral G from curvature and speed
    const latG = pts[i].curvatureM * spdMs * spdMs / 9.81;
    // Longitudinal G from speed change
    const lonG = i > 0 ? ((spd - prevSpeed) / 3.6) / (9.81 * (t - times[i - 1] || 1/60)) : 0;
    prevSpeed = spd;

    // Tyre slip ratios (simplified physics)
    const slipRatioBase = Math.abs(steering[i]) * 0.08 + brake[i] * 0.12;
    const slipRatioFront = slipRatioBase + Math.random() * 0.01;
    const slipRatioRear  = slipRatioBase * 1.2 + throttle[i] * 0.06 + Math.random() * 0.01;

    // Tyre slip angles (degrees)
    const saFront = Math.atan(latG * 0.4) * (180 / Math.PI);
    const saRear  = Math.atan(latG * 0.3) * (180 / Math.PI);

    // Tyre temperatures
    const heatFront = (Math.abs(latG) * 1.4 + brake[i] * 3.5) * (1 / 60);
    const heatRear  = (Math.abs(latG) * 1.4 + throttle[i] * 2.5) * (1 / 60);
    const coolRate  = 0.8 * (1 / 60);
    tyreTemp[0] = Math.max(80, Math.min(115, tyreTemp[0] + heatFront - coolRate));
    tyreTemp[1] = Math.max(80, Math.min(115, tyreTemp[1] + heatFront - coolRate));
    tyreTemp[2] = Math.max(80, Math.min(115, tyreTemp[2] + heatRear  - coolRate));
    tyreTemp[3] = Math.max(80, Math.min(115, tyreTemp[3] + heatRear  - coolRate));

    // Tyre pressures (PSI, minor thermal variation)
    const psi = [27.5, 27.5, 28.0, 28.0].map((p, k) => p + (tyreTemp[k] - 90) * 0.02);

    // Wheel loads (N) — lateral/longitudinal transfer, 650 kg car (half-car model)
    const BASE = 1600; // N per corner
    const dLat = latG * 480;
    const dLon = lonG * 320;
    const loads = [
      Math.max(100, BASE - dLat + dLon),
      Math.max(100, BASE + dLat + dLon),
      Math.max(100, BASE - dLat - dLon),
      Math.max(100, BASE + dLat - dLon),
    ];

    // Suspension travel (mm): stiffer at higher load, 0-50mm range
    const travelBase = 25; // mm neutral
    const springK    = 60; // N/mm
    const travels    = loads.map(l => Math.max(0, Math.min(50, travelBase + (l - BASE) / springK)));

    // Brake disc temps
    const brakeHeat = brake[i] * 900;
    const brakeCool = 80;
    brakeTemp[0] = Math.max(200, Math.min(650, brakeTemp[0] + (brakeHeat - brakeCool) * (1/60)));
    brakeTemp[1] = Math.max(200, Math.min(650, brakeTemp[1] + (brakeHeat - brakeCool) * (1/60)));
    brakeTemp[2] = Math.max(150, Math.min(500, brakeTemp[2] + (brakeHeat * 0.6 - brakeCool) * (1/60)));
    brakeTemp[3] = Math.max(150, Math.min(500, brakeTemp[3] + (brakeHeat * 0.6 - brakeCool) * (1/60)));

    const sector = Math.min(5, Math.floor(i / SECTOR_SIZE) + 1);

    rows.push({
      index:     i,
      timestamp: BigInt(Math.round(t * 1e9)),
      distance:  +pts[i].dist.toFixed(2),
      x: +pts[i].x.toFixed(3), y: +pts[i].y.toFixed(3), z: 0,
      yaw: +pts[i].yaw.toFixed(5),
      vx: +vx.toFixed(3), vy: +vy.toFixed(3),
      speed:    +spd.toFixed(2),
      throttle: +throttle[i].toFixed(3),
      brake:    +brake[i].toFixed(3),
      clutch:   0,
      steering: +steering[i].toFixed(4),
      rpm, gear,
      sector,
      // tyres
      slipRatioFL: +slipRatioFront.toFixed(4),
      slipRatioFR: +slipRatioFront.toFixed(4),
      slipRatioRL: +slipRatioRear.toFixed(4),
      slipRatioRR: +slipRatioRear.toFixed(4),
      slipAngleFL: +saFront.toFixed(3),
      slipAngleFR: +saFront.toFixed(3),
      slipAngleRL: +saRear.toFixed(3),
      slipAngleRR: +saRear.toFixed(3),
      tempFL: +tyreTemp[0].toFixed(1), tempFR: +tyreTemp[1].toFixed(1),
      tempRL: +tyreTemp[2].toFixed(1), tempRR: +tyreTemp[3].toFixed(1),
      pressureFL: +psi[0].toFixed(2), pressureFR: +psi[1].toFixed(2),
      pressureRL: +psi[2].toFixed(2), pressureRR: +psi[3].toFixed(2),
      // suspension
      loadFL: Math.round(loads[0]), loadFR: Math.round(loads[1]),
      loadRL: Math.round(loads[2]), loadRR: Math.round(loads[3]),
      travelFL: +travels[0].toFixed(2), travelFR: +travels[1].toFixed(2),
      travelRL: +travels[2].toFixed(2), travelRR: +travels[3].toFixed(2),
      // brakes
      discTempFL: Math.round(brakeTemp[0]), discTempFR: Math.round(brakeTemp[1]),
      discTempRL: Math.round(brakeTemp[2]), discTempRR: Math.round(brakeTemp[3]),
    });
  }

  return rows;
}

// ── Imperfections ─────────────────────────────────────────────────────────────

function applyImperfections(refRows, refSpeeds) {
  const speeds   = Float64Array.from(refSpeeds);
  const throttle = new Float64Array(refRows.map(r => r.throttle));
  const brake    = new Float64Array(refRows.map(r => r.brake));
  const steering = new Float64Array(refRows.map(r => r.steering));

  // S2 (1080–2159): late braking — shift brake 8 pts later, lower corner minimum
  for (let i = 1080; i < 2160; i++) {
    if (brake[i] > 0.3) {
      // Shift brake spike 8 points later: copy current to i+8, clear i
      const dest = Math.min(i + 8, 2159);
      brake[dest] = Math.max(brake[dest], brake[i]);
      brake[i]   *= 0.15;
      // Speed 5-8 km/h higher at the delayed braking point
      if (i < i + 8) speeds[i] = Math.min(speeds[i] + 6, 185);
    }
    // Reduce corner minimum speed (missed apex → wider line)
    if (speeds[i] < 115) {
      speeds[i] = Math.max(speeds[i] - 5, 75);
    }
  }

  // S3 (2160–3239): early throttle → throttle 12 pts earlier, speed scrub 20 pts
  for (let i = 2160; i < 3240; i++) {
    // Advance throttle
    const src = Math.min(i + 12, 3239);
    if (throttle[src] > throttle[i]) throttle[i] = throttle[src] * 0.8;
    // Speed scrub in mid-corner zone (around peak curvature area)
    const rel = i - 2160;
    if (rel >= 300 && rel < 320) {
      speeds[i] = Math.max(speeds[i] - 5, 70);
    }
  }

  // S4 (3240–4319): steering oscillation, minor speed loss
  for (let i = 3240; i < 4320; i++) {
    const rel = i - 3240;
    if (rel < 30) {
      steering[i] += Math.sin(rel * 0.7) * 0.08;
      speeds[i]   = Math.max(speeds[i] - 0.8, 70);
    }
  }

  // S1 and S5: ±2% random noise on all speeds
  function addNoise(start, end) {
    for (let i = start; i < end; i++) {
      speeds[i] *= 1 + (Math.random() - 0.5) * 0.04;
    }
  }
  addNoise(0, 1080);
  addNoise(4320, 5400);

  return { speeds, throttle, brake, steering };
}

// ── Sector boundary helpers ───────────────────────────────────────────────────

function sectorBoundaries() {
  const bounds = [];
  for (let s = 0; s < 5; s++) {
    bounds.push({
      id:         s + 1,
      startIndex: s * SECTOR_SIZE,
      endIndex:   (s + 1) * SECTOR_SIZE - 1,
    });
  }
  return bounds;
}

// ── Main export ───────────────────────────────────────────────────────────────

function generate() {
  const pts = buildPath();

  // Reference
  const refSpeedsRaw = buildSpeeds(pts);
  const { speeds: refSpeeds, times: refTimes } =
    scaleSpeedsToLapTime(pts, refSpeedsRaw, REF_LAP_TIME);
  const refInputs = buildInputs(pts, refSpeeds);
  const reference = buildDerived(pts, refSpeeds, refInputs, refTimes);

  // Current: apply imperfections then scale to target time
  const imp = applyImperfections(reference, refSpeeds);
  // Rebuild derived arrays from modified speeds/inputs
  const curInputs = {
    throttle: imp.throttle,
    brake:    imp.brake,
    steering: imp.steering,
  };
  const { speeds: curSpeeds, times: curTimes } =
    scaleSpeedsToLapTime(pts, imp.speeds, CUR_LAP_TIME);
  const current = buildDerived(pts, curSpeeds, curInputs, curTimes);

  const bounds = sectorBoundaries();

  const refLapTime = refTimes[N - 1];
  const curLapTime = curTimes[N - 1];

  return {
    reference,
    current,
    sectorBoundaries: bounds,
    refLapTime: +refLapTime.toFixed(3),
    curLapTime: +curLapTime.toFixed(3),
    refTimes,
    curTimes,
  };
}

module.exports = { generate, N, SECTOR_SIZE };
