/**
 * Layout registry and rotor-station solver.
 *
 * A line-for-line port of the Python airframe solver the Drone Surrogate Factory started from.
 *
 * The rule that keeps models honest: rotor stations are DERIVED from the approved length and
 * width, never typed in. Rotor diameter is the free parameter. For ring layouts the stations sit
 * on an ellipse so the outermost swept rotor discs touch the envelope on both axes:
 *
 *     rx = (L/2 - r) / max|cos t_i|        ry = (W/2 - r) / max|sin t_i|
 */
import type { LayoutId, LayoutKind, ShapeRatios } from './types'

export interface LayoutDef {
  label: string
  kind: LayoutKind
  angles: number[]          // degrees from +X toward +Y
  coax: 0 | 1 | 2           // rotors per station
  ringFrom?: 'boom'
  ringX?: number
  ringY?: number
  envelope: string          // what the published L x W means for this family
  blurb: string
}

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  quad_x: { label: 'Quad X', kind: 'ring', angles: [45, 135, 225, 315], coax: 1,
    envelope: 'rotor tip to rotor tip, diagonal frame', blurb: 'The default for camera and inspection drones.' },
  quad_plus: { label: 'Quad +', kind: 'ring', angles: [0, 90, 180, 270], coax: 1,
    envelope: 'rotor tip to rotor tip, in-line frame', blurb: 'One rotor leads; simple and symmetric.' },
  quad_h: { label: 'Quad H', kind: 'ring', angles: [35, 145, 215, 325], coax: 1,
    envelope: 'rotor tip to rotor tip; wide lateral stance', blurb: 'Wide stance, long body for payload bays.' },
  tri_y: { label: 'Tricopter Y', kind: 'ring', angles: [60, 180, 300], coax: 1,
    envelope: 'rotor tip to rotor tip; single rear boom', blurb: 'Three arms. Light, agile, a little twitchy.' },
  hexa_x: { label: 'Hexa X', kind: 'ring', angles: [30, 90, 150, 210, 270, 330], coax: 1,
    envelope: 'rotor tip to rotor tip', blurb: 'Six rotors: survives a motor failure.' },
  hexa_plus: { label: 'Hexa +', kind: 'ring', angles: [0, 60, 120, 180, 240, 300], coax: 1,
    envelope: 'rotor tip to rotor tip', blurb: 'Six rotors, one leading.' },
  octo_x: { label: 'Octo X', kind: 'ring', angles: [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5], coax: 1,
    envelope: 'rotor tip to rotor tip', blurb: 'Heavy lift cinema and industrial work.' },
  octo_plus: { label: 'Octo +', kind: 'ring', angles: [0, 45, 90, 135, 180, 225, 270, 315], coax: 1,
    envelope: 'rotor tip to rotor tip', blurb: 'Eight rotors on eight arms.' },
  y6: { label: 'Y6 coaxial', kind: 'ring', angles: [60, 180, 300], coax: 2,
    envelope: 'rotor tip to rotor tip; three arms, six rotors', blurb: 'Coaxial pairs on three arms. Compact for its lift.' },
  x8: { label: 'X8 coaxial', kind: 'ring', angles: [45, 135, 225, 315], coax: 2,
    envelope: 'rotor tip to rotor tip; four arms, eight rotors', blurb: 'Coaxial pairs on four arms. Redundant heavy lift.' },
  vtol_quadplane: { label: 'VTOL quadplane', kind: 'wing_ring', angles: [40, 140, 220, 320], coax: 1,
    ringFrom: 'boom', ringX: 0.32, ringY: 0.24,
    envelope: 'W is WINGSPAN, L is fuselage length — not rotor tips', blurb: 'Takes off like a quad, cruises like a plane.' },
  fixed_wing: { label: 'Fixed-wing', kind: 'wing', angles: [], coax: 0,
    envelope: 'W is WINGSPAN, L is fuselage length', blurb: 'Fast and efficient. Needs speed to stay up.' },
  heli: { label: 'Helicopter', kind: 'heli', angles: [], coax: 1,
    envelope: 'L is nose to tail including the disc; W is main rotor diameter', blurb: 'One big rotor: efficient hover, long reach.' },
}

export const LAYOUT_IDS = Object.keys(LAYOUTS) as LayoutId[]

const FAMILY_DEFAULTS: Record<LayoutKind, { rotor: number; bl: number; bw: number; bh: number }> = {
  ring: { rotor: 0.397, bl: 0.695, bw: 0.255, bh: 0.185 },
  wing_ring: { rotor: 0.270, bl: 0.940, bw: 0.110, bh: 0.130 },
  wing: { rotor: 0.260, bl: 0.960, bw: 0.105, bh: 0.125 },
  heli: { rotor: 0.980, bl: 0.520, bw: 0.150, bh: 0.220 },
}

export function rotorCount(id: LayoutId): number {
  const l = LAYOUTS[id]
  if (l.kind === 'wing') return 1
  if (l.kind === 'heli') return 1
  return l.angles.length * l.coax
}

/** More rotors on the same envelope means each must be smaller or the discs overlap. */
export function crowding(id: LayoutId): number {
  const n = Math.max(LAYOUTS[id].angles.length, 1)
  return n <= 4 ? 1.0 : n <= 6 ? 0.74 : 0.58
}

export function defaultRatios(id: LayoutId): ShapeRatios {
  const kind = LAYOUTS[id].kind
  const f = FAMILY_DEFAULTS[kind]
  const wing = kind === 'wing' || kind === 'wing_ring'
  return {
    rotor: +(f.rotor * crowding(id)).toFixed(4),
    bodyL: f.bl, bodyW: f.bw, bodyH: f.bh,
    armR: 0.031, motorR: 0.034, motorH: 0.048, bladeChord: 0.048,
    gearH: kind === 'heli' ? 0.12 : wing ? 0.0 : 0.10,
    wingRoot: wing ? 0.26 : 0, wingTip: wing ? 0.16 : 0, wingSweep: wing ? 0.075 : 0,
    wingThick: wing ? 0.030 : 0, wingDihedral: wing ? 0.025 : 0, tailScale: 1,
  }
}

export interface Station { index: number; tag: string; x: number; y: number; deg: number }
export interface StationSolution { stations: Station[]; rx: number; ry: number; feasible: boolean; residual: number }

export function stationTag(deg: number, i: number): string {
  const d = ((deg % 360) + 360) % 360
  const fb = d < 90 || d > 270 ? 'front' : d > 90 && d < 270 ? 'rear' : 'mid'
  const lr = d > 0 && d < 180 ? 'left' : d > 180 && d < 360 ? 'right' : 'centre'
  return fb === 'mid' ? `side_${lr}_${i}` : `${fb}_${lr}_${i}`
}

export function solveStations(layout: LayoutId, L: number, W: number, propDiameter: number): StationSolution {
  const lay = LAYOUTS[layout]
  const pr = propDiameter / 2
  if (!lay.angles.length) return { stations: [], rx: 0, ry: 0, feasible: true, residual: 0 }
  const rad = lay.angles.map(a => (a * Math.PI) / 180)
  const cmax = Math.max(...rad.map(t => Math.abs(Math.cos(t))))
  const smax = Math.max(...rad.map(t => Math.abs(Math.sin(t))))

  if (lay.ringFrom === 'boom') {
    // Boom-mounted lift rotors (quadplanes): a fixed fraction of the airframe. The wing owns the
    // span and the fuselage owns the length, so back-solving them to the envelope would fling
    // them to the wingtips.
    const rx = (L * (lay.ringX ?? 0.32)) / Math.max(cmax, 1e-9)
    const ry = (W * (lay.ringY ?? 0.24)) / Math.max(smax, 1e-9)
    const clash = pr - W * (lay.ringY ?? 0.24)
    return {
      stations: rad.map((t, i) => ({ index: i, tag: stationTag(lay.angles[i], i), x: rx * Math.cos(t), y: ry * Math.sin(t), deg: lay.angles[i] })),
      rx, ry, feasible: clash <= 0, residual: Math.max(clash, 0),
    }
  }

  const overX = pr - L / 2
  const overY = pr - W / 2
  const rx = cmax > 1e-9 ? Math.max((L / 2 - pr) / cmax, 0) : 0
  const ry = smax > 1e-9 ? Math.max((W / 2 - pr) / smax, 0) : 0
  return {
    stations: rad.map((t, i) => ({ index: i, tag: stationTag(lay.angles[i], i), x: rx * Math.cos(t), y: ry * Math.sin(t), deg: lay.angles[i] })),
    rx, ry, feasible: overX <= 0 && overY <= 0, residual: Math.max(overX, overY, 0),
  }
}

export function className(id: LayoutId): string {
  const k = LAYOUTS[id].kind
  if (k === 'wing') return 'Fixed-wing'
  if (k === 'wing_ring') return 'VTOL'
  if (k === 'heli') return 'Helicopter'
  const n = LAYOUTS[id].angles.length * LAYOUTS[id].coax
  return n === 3 ? 'Tricopter' : n === 4 ? 'Quadcopter' : n === 6 ? 'Hexacopter' : n === 8 ? 'Octocopter' : 'Multirotor'
}
