/**
 * Component catalogue. Every number here is an ESTIMATE used by the performance model. Motor,
 * battery and avionics figures sit inside the range of real hobby/industrial parts of each
 * class; they are not the datasheet of any one product. The one exception is the Livox Avia,
 * whose mass and power are the published datasheet values (livoxtech.com/avia/specs).
 *
 * Weapon and countermeasure modules are fictional game modules with abstract stats. They exist
 * for the simulator and are deliberately generic.
 */
import type { AvionicsTier, Chemistry, FrameMaterial, Mount, PropMaterial } from './types'

export interface MotorDef {
  id: string
  label: string
  kv: number
  minS: number
  maxS: number
  maxPowerW: number
  massKg: number
  priceUsd: number
  /** Prop diameter (m) this class is built to swing. Used for hints, not hard limits. */
  propM: [number, number]
}

export const MOTORS: MotorDef[] = [
  { id: 'm0802', label: '0802 · 19000KV micro', kv: 19000, minS: 1, maxS: 1, maxPowerW: 28, massKg: 0.0025, priceUsd: 12, propM: [0.03, 0.045] },
  { id: 'm1103', label: '1103 · 10000KV', kv: 10000, minS: 1, maxS: 2, maxPowerW: 70, massKg: 0.0042, priceUsd: 14, propM: [0.045, 0.065] },
  { id: 'm1404', label: '1404 · 3800KV', kv: 3800, minS: 3, maxS: 4, maxPowerW: 220, massKg: 0.0095, priceUsd: 18, propM: [0.07, 0.10] },
  { id: 'm2306', label: '2306 · 2450KV racer', kv: 2450, minS: 4, maxS: 6, maxPowerW: 850, massKg: 0.032, priceUsd: 24, propM: [0.115, 0.14] },
  { id: 'm2810', label: '2810 · 1100KV', kv: 1100, minS: 4, maxS: 6, maxPowerW: 900, massKg: 0.058, priceUsd: 45, propM: [0.17, 0.21] },
  { id: 'm3110', label: '3110 · 900KV', kv: 900, minS: 4, maxS: 6, maxPowerW: 760, massKg: 0.080, priceUsd: 55, propM: [0.21, 0.26] },
  { id: 'm3510', label: '3510 · 700KV', kv: 700, minS: 4, maxS: 6, maxPowerW: 650, massKg: 0.105, priceUsd: 65, propM: [0.26, 0.33] },
  { id: 'm4114', label: '4114 · 400KV', kv: 400, minS: 6, maxS: 6, maxPowerW: 900, massKg: 0.16, priceUsd: 95, propM: [0.33, 0.41] },
  { id: 'm5015', label: '5015 · 340KV', kv: 340, minS: 6, maxS: 12, maxPowerW: 1300, massKg: 0.21, priceUsd: 140, propM: [0.38, 0.46] },
  { id: 'm6215', label: '6215 · 170KV', kv: 170, minS: 12, maxS: 12, maxPowerW: 2200, massKg: 0.39, priceUsd: 260, propM: [0.48, 0.61] },
  { id: 'm8318', label: '8318 · 100KV', kv: 100, minS: 12, maxS: 14, maxPowerW: 3500, massKg: 0.69, priceUsd: 480, propM: [0.66, 0.76] },
  { id: 'mU15', label: 'U15 heavy-lift · 80KV', kv: 80, minS: 12, maxS: 24, maxPowerW: 9000, massKg: 2.3, priceUsd: 1300, propM: [0.95, 1.12] },
]

export const motorById = (id: string) => MOTORS.find(m => m.id === id) ?? MOTORS[4]

/** Pick the motor class built for a given prop diameter. */
export function motorForProp(propM: number): MotorDef {
  let best = MOTORS[0]
  let bestErr = Infinity
  for (const m of MOTORS) {
    const mid = (m.propM[0] + m.propM[1]) / 2
    const err = Math.abs(Math.log(propM / mid))
    if (err < bestErr) { bestErr = err; best = m }
  }
  return best
}

export interface ChemistryDef {
  id: Chemistry
  label: string
  whPerKg: number
  cellV: number
  maxC: number
  usdPerWh: number
  note: string
}

export const CHEMISTRY: Record<Chemistry, ChemistryDef> = {
  lipo: { id: 'lipo', label: 'LiPo', whPerKg: 160, cellV: 3.7, maxC: 60, usdPerWh: 0.85, note: 'High current, moderate energy. The racing default.' },
  liion: { id: 'liion', label: 'Li-ion 21700', whPerKg: 230, cellV: 3.6, maxC: 8, usdPerWh: 0.55, note: 'Long endurance, limited current. Cruisers and mappers.' },
  solid: { id: 'solid', label: 'Solid-state', whPerKg: 330, cellV: 3.7, maxC: 15, usdPerWh: 2.8, note: 'Emerging chemistry. Energy-dense and expensive.' },
  hydrogen: { id: 'hydrogen', label: 'Hydrogen fuel cell', whPerKg: 650, cellV: 3.7, maxC: 0, usdPerWh: 3.5, note: 'Hours of flight, heavy stack, limited peak power.' },
}

/** Hydrogen: fixed stack mass and a continuous power ceiling instead of a C rating. */
export const HYDROGEN = { stackKg: 0.95, stackUsd: 2600, basePowerW: 900, powerPerWh: 0.25 }

export interface FrameMatDef { id: FrameMaterial; label: string; massFactor: number; priceFactor: number; durability: number; rcs: number; note: string }

export const FRAME_MATERIALS: Record<FrameMaterial, FrameMatDef> = {
  polymer: { id: 'polymer', label: 'Injection polymer', massFactor: 1.35, priceFactor: 0.5, durability: 0.8, rcs: 0.55, note: 'Cheap, heavy, radar-transparent.' },
  carbon: { id: 'carbon', label: 'Carbon fibre', massFactor: 1.0, priceFactor: 1.6, durability: 1.0, rcs: 0.75, note: 'Light and stiff. The reference.' },
  aluminium: { id: 'aluminium', label: 'Aluminium', massFactor: 1.55, priceFactor: 1.0, durability: 1.35, rcs: 1.25, note: 'Tough and heavy. Bright on radar.' },
  ti_carbon: { id: 'ti_carbon', label: 'Titanium-carbon', massFactor: 0.9, priceFactor: 3.2, durability: 1.6, rcs: 0.8, note: 'Lightest and toughest. Priced like it.' },
}

export interface AvionicsDef { id: AvionicsTier; label: string; massKg: number; powerW: number; priceUsd: number; maxTiltDeg: number; accuracy: number; linkKm: number; note: string }

export const AVIONICS: Record<AvionicsTier, AvionicsDef> = {
  hobby: { id: 'hobby', label: 'Hobby FC + GPS', massKg: 0.035, powerW: 3, priceUsd: 90, maxTiltDeg: 35, accuracy: 58, linkKm: 2, note: 'Single IMU, consumer GPS.' },
  pro: { id: 'pro', label: 'Pro autopilot + RTK', massKg: 0.12, powerW: 9, priceUsd: 780, maxTiltDeg: 45, accuracy: 76, linkKm: 15, note: 'Dual IMU, centimetre RTK, long link.' },
  mil: { id: 'mil', label: 'Redundant INS stack', massKg: 0.35, powerW: 22, priceUsd: 5200, maxTiltDeg: 55, accuracy: 90, linkKm: 40, note: 'Triple-redundant, GNSS-denied capable.' },
}

export const PROP_MATERIALS: Record<PropMaterial, { label: string; ct: number; cp: number; massFactor: number; priceFactor: number }> = {
  plastic: { label: 'Glass-filled nylon', ct: 1.0, cp: 1.0, massFactor: 1.0, priceFactor: 1.0 },
  carbon: { label: 'Carbon fibre', ct: 1.03, cp: 0.97, massFactor: 0.8, priceFactor: 4.0 },
}

// ───────────────────────────── loadout modules ─────────────────────────────

export type WeaponBehaviour = 'kinetic' | 'bomb' | 'net' | 'missile' | 'laser' | 'emp'
export type SystemBehaviour = 'radar' | 'lidar' | 'thermal' | 'carrier' | 'searchlight' | 'smoke' | 'winch' | 'stealth' | 'parachute'

export interface ModuleDef<B extends string> {
  id: B
  name: string
  short: string
  massKg: number
  powerW: number
  priceUsd: number
  /** Frontal drag area added, m^2. */
  dragM2: number
  mounts: Mount[]
  blurb: string
  stats: Record<string, number | string>
  /** Glyph used in the UI. */
  glyph: string
}

export const WEAPONS: ModuleDef<WeaponBehaviour>[] = [
  { id: 'kinetic', name: 'KN-7 Kinetic Turret', short: 'Turret', massKg: 1.35, powerW: 35, priceUsd: 3200, dragM2: 0.012,
    mounts: ['belly', 'nose'], glyph: '⊕',
    blurb: 'Rapid single-shot projectiles. Spread grows on light, twitchy airframes.',
    stats: { ammo: 240, rate: 7, damage: 10, spreadDeg: 0.9, speed: 280, range: 350, recoil: 0.9 } },
  { id: 'bomb', name: 'GB-4 Gravity Rack', short: 'Bombs', massKg: 1.65, powerW: 5, priceUsd: 1100, dragM2: 0.018,
    mounts: ['belly', 'left', 'right'], glyph: '▼',
    blurb: 'Four unpowered drop payloads. Lead your release: they keep your speed.',
    stats: { ammo: 4, damage: 80, blastM: 7, range: 0 } },
  { id: 'net', name: 'NL-3 Net Launcher', short: 'Nets', massKg: 0.85, powerW: 6, priceUsd: 1450, dragM2: 0.010,
    mounts: ['nose', 'belly'], glyph: '⌗',
    blurb: 'Captures drones intact. Short range, generous spread.',
    stats: { ammo: 4, speed: 38, range: 32, netM: 4.2 } },
  { id: 'missile', name: 'MH-2 Micro-Missile Pod', short: 'Missiles', massKg: 1.1, powerW: 12, priceUsd: 5800, dragM2: 0.014,
    mounts: ['left', 'right', 'belly'], glyph: '➶',
    blurb: 'Two homing rounds. Hold a target in the reticle to lock.',
    stats: { ammo: 2, damage: 60, lockS: 1.1, range: 420, speed: 90 } },
  { id: 'laser', name: 'LD-1 Laser Designator', short: 'Designator', massKg: 0.32, powerW: 18, priceUsd: 2600, dragM2: 0.003,
    mounts: ['nose', 'belly'], glyph: '⟋',
    blurb: 'Paints targets: painted targets score double and show through walls.',
    stats: { range: 800, ammo: 'unlimited' } },
  { id: 'emp', name: 'EP-9 Pulse Emitter', short: 'Pulse', massKg: 1.4, powerW: 220, priceUsd: 7900, dragM2: 0.016,
    mounts: ['top', 'belly'], glyph: '◎',
    blurb: 'Disables every drone in a bubble. Long recharge, big power draw.',
    stats: { radius: 18, cooldownS: 12, ammo: 'recharge' } },
]

export const SYSTEMS: ModuleDef<SystemBehaviour>[] = [
  { id: 'radar', name: 'RX-1 Compact Radar', short: 'Radar', massKg: 0.7, powerW: 45, priceUsd: 4200, dragM2: 0.010,
    mounts: ['top', 'nose'], glyph: '◠',
    blurb: 'Shows every target within range on the minimap, through terrain.', stats: { rangeM: 900 } },
  { id: 'lidar', name: 'Livox Avia LiDAR', short: 'LiDAR', massKg: 0.498, powerW: 8, priceUsd: 2079, dragM2: 0.006,
    mounts: ['nose', 'belly'], glyph: '✺',
    blurb: 'Live non-repetitive point cloud in flight. Datasheet mass and power.',
    stats: { rangeM: 190, fovH: 70.4, fovV: 77.2, ptsPerS: 240000 } },
  { id: 'thermal', name: 'TH-640 Thermal Camera', short: 'Thermal', massKg: 0.23, powerW: 4, priceUsd: 3100, dragM2: 0.003,
    mounts: ['nose', 'belly'], glyph: '◐',
    blurb: 'Heat vision. Engines and motors glow through night and smoke.', stats: { res: '640×512' } },
  { id: 'carrier', name: 'CB-3 Carrier Bay', short: 'Carrier', massKg: 1.9, powerW: 15, priceUsd: 4800, dragM2: 0.020,
    mounts: ['belly'], glyph: '⋔',
    blurb: 'Launches three micro-drones that scout and harass targets.', stats: { drones: 3, lifeS: 40 } },
  { id: 'searchlight', name: 'SL-20 Searchlight', short: 'Light', massKg: 0.42, powerW: 60, priceUsd: 650, dragM2: 0.004,
    mounts: ['nose', 'belly'], glyph: '☀',
    blurb: '20,000 lumen steerable light. Essential after dark.', stats: { lumens: 20000 } },
  { id: 'smoke', name: 'SD-6 Smoke Dispenser', short: 'Smoke', massKg: 0.55, powerW: 2, priceUsd: 400, dragM2: 0.006,
    mounts: ['tail', 'belly'], glyph: '≋',
    blurb: 'Six canisters. Breaks missile locks and hides you from sentries.', stats: { ammo: 6 } },
  { id: 'winch', name: 'WH-15 Cargo Winch', short: 'Winch', massKg: 0.95, powerW: 30, priceUsd: 1200, dragM2: 0.006,
    mounts: ['belly'], glyph: '⚓',
    blurb: 'Hook, lift and deliver crates. The load swings — fly smooth.', stats: { cableM: 15, maxLoadKg: 5 } },
  { id: 'stealth', name: 'RAM Stealth Skin', short: 'Stealth', massKg: 0, powerW: 0, priceUsd: 0, dragM2: 0,
    mounts: ['top'], glyph: '◇',
    blurb: 'Radar-absorbing, low-reflectivity coat. Cuts RCS and LiDAR returns.', stats: { rcsFactor: 0.3, lidarFactor: 0.4 } },
  { id: 'parachute', name: 'PR-2 Recovery Chute', short: 'Chute', massKg: 0.35, powerW: 0, priceUsd: 450, dragM2: 0.004,
    mounts: ['top'], glyph: '☂',
    blurb: 'Saves the airframe once: a crash becomes a soft landing.', stats: { saves: 1 } },
]

export const weaponById = (id: string) => WEAPONS.find(w => w.id === id)
export const systemById = (id: string) => SYSTEMS.find(s => s.id === id)

/** Stealth skin scales with the airframe, so it is priced and weighed from wetted area. */
export function stealthSkin(L: number, W: number) {
  const area = 2.2 * L * W
  return { massKg: 0.6 * area, priceUsd: Math.round(3500 * Math.max(area, 0.05) + 900) }
}

/** Chute scales with what it has to lower. */
export function chuteFor(massKg: number) {
  return { massKg: 0.12 + 0.045 * Math.pow(Math.max(massKg, 0.2), 0.85), priceUsd: Math.round(250 + 60 * massKg) }
}

export const MOUNT_LABEL: Record<Mount, string> = {
  belly: 'Belly', nose: 'Nose', top: 'Top', tail: 'Tail', left: 'Left pylon', right: 'Right pylon',
}
