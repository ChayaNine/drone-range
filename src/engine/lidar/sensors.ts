/**
 * LiDAR sensor models.
 *
 * Livox Avia numbers are the published datasheet (livoxtech.com/avia/specs, accessed 2026-10-13):
 *   FOV non-repetitive 70.4° H × 77.2° V; repetitive line 70.4° × 4.5°
 *   240,000 pts/s (first or strongest return)
 *   190 m @ 10% reflectivity, 450 m @ 80% (0 klx)
 *   range precision 2 cm (1σ @ 20 m); angular precision < 0.05° (1σ)
 *   beam divergence 0.28° (V) × 0.03° (H); 905 nm; 498 g; 8 W non-repetitive
 *
 * The Avia's exact scan trajectory is not published. It is modelled as interleaved Risley-prism
 * rosettes with an irrational frequency ratio, which reproduces the property that matters: the
 * pattern never repeats, so coverage keeps growing with integration time and is densest at the
 * centre. The two spinning sensors are generic classes, labelled as such.
 */

export type SensorId = 'avia' | 'avia_line' | 'spin64' | 'spin16'

export interface SensorDef {
  id: SensorId
  name: string
  short: string
  kind: 'rosette' | 'line' | 'spinning'
  fovH: number
  fovV: number
  pointsPerSec: number
  range10: number
  range80: number
  rangeSigma: number
  angSigmaDeg: number
  divH: number
  divV: number
  channels: number
  hz: number
  minRange: number
  source: string
  verified: boolean
}

export const SENSORS: Record<SensorId, SensorDef> = {
  avia: {
    id: 'avia', name: 'Livox Avia — non-repetitive', short: 'Avia', kind: 'rosette',
    fovH: 70.4, fovV: 77.2, pointsPerSec: 240000, range10: 190, range80: 450, rangeSigma: 0.02, angSigmaDeg: 0.05,
    divH: 0.03, divV: 0.28, channels: 6, hz: 10, minRange: 1,
    source: 'Livox Avia datasheet, livoxtech.com/avia/specs (accessed 2026-10-13). Scan trajectory approximated.', verified: true,
  },
  avia_line: {
    id: 'avia_line', name: 'Livox Avia — repetitive line', short: 'Avia line', kind: 'line',
    fovH: 70.4, fovV: 4.5, pointsPerSec: 240000, range10: 190, range80: 450, rangeSigma: 0.02, angSigmaDeg: 0.05,
    divH: 0.03, divV: 0.28, channels: 6, hz: 10, minRange: 1,
    source: 'Livox Avia datasheet, repetitive line scanning mode.', verified: true,
  },
  spin64: {
    id: 'spin64', name: '64-channel spinning (OS1 class)', short: '64-ch', kind: 'spinning',
    fovH: 360, fovV: 33.2, pointsPerSec: 655360, range10: 60, range80: 120, rangeSigma: 0.03, angSigmaDeg: 0.01,
    divH: 0.13, divV: 0.13, channels: 64, hz: 10, minRange: 0.8,
    source: 'Generic 64-channel mechanical LiDAR, 1024 × 10 Hz. Class figures, not a specific datasheet.', verified: false,
  },
  spin16: {
    id: 'spin16', name: '16-channel spinning (VLP-16 class)', short: '16-ch', kind: 'spinning',
    fovH: 360, fovV: 30, pointsPerSec: 288000, range10: 50, range80: 100, rangeSigma: 0.03, angSigmaDeg: 0.02,
    divH: 0.17, divV: 0.17, channels: 16, hz: 10, minRange: 0.5,
    source: 'Generic 16-channel mechanical LiDAR, 0.2° azimuth × 10 Hz. Class figures, not a specific datasheet.', verified: false,
  },
}

const DEG = Math.PI / 180

/** Maximum detection range for a surface of reflectivity rho (power law through the 10% and 80% points). */
export function maxRange(s: SensorDef, rho: number): number {
  const gamma = Math.log(s.range80 / s.range10) / Math.log(8)
  return s.range10 * Math.pow(Math.max(rho, 0.005) / 0.1, gamma)
}

/** Probability of a return: a soft edge around the max range, so detection fades rather than cuts. */
export function returnProbability(s: SensorDef, rangeM: number, rho: number, cosInc: number): number {
  if (rangeM < s.minRange) return 0
  const R = maxRange(s, rho * Math.max(cosInc, 0.08))
  return 1 / (1 + Math.exp((rangeM - R) / (0.07 * R)))
}

/**
 * Beam direction for point index k, in the SENSOR frame: x forward, y left, z up.
 * Returns [azimuth, elevation] in radians.
 */
export function beamAngles(s: SensorDef, k: number, out: [number, number]): [number, number] {
  const t = k / s.pointsPerSec
  if (s.kind === 'rosette') {
    const c = k % s.channels
    const ph = (2 * Math.PI * c) / s.channels
    const w1 = 2 * Math.PI * 17.3, w2 = -2 * Math.PI * 27.991 // irrational-ish ratio → never repeats
    const re = 0.5 * Math.cos(w1 * t + ph) + 0.5 * Math.cos(w2 * t + ph * 1.618)
    const im = 0.5 * Math.sin(w1 * t + ph) + 0.5 * Math.sin(w2 * t + ph * 1.618)
    out[0] = re * (s.fovH / 2) * DEG
    out[1] = im * (s.fovV / 2) * DEG
    return out
  }
  if (s.kind === 'line') {
    const c = k % s.channels
    const sweep = Math.sin(2 * Math.PI * s.hz * t * 2)
    out[0] = sweep * (s.fovH / 2) * DEG
    out[1] = ((c / (s.channels - 1)) - 0.5) * s.fovV * DEG
    return out
  }
  // spinning: channels fire together at each azimuth step
  const c = k % s.channels
  const step = Math.floor(k / s.channels)
  const stepsPerRev = s.pointsPerSec / s.channels / s.hz
  out[0] = ((step % stepsPerRev) / stepsPerRev) * 2 * Math.PI - Math.PI
  out[1] = (-s.fovV / 2 + (s.fovV * c) / (s.channels - 1)) * DEG
  return out
}

/** Unit vector for (az, el) in sensor frame. */
export function angleToDir(az: number, el: number, out: { x: number; y: number; z: number }) {
  const ce = Math.cos(el)
  out.x = ce * Math.cos(az)
  out.y = ce * Math.sin(az)
  out.z = Math.sin(el)
  return out
}
