/**
 * Performance model. Turns a spec into mass, thrust, power, speed, endurance, agility,
 * accuracy, signatures, price and a flight-readiness verdict.
 *
 * Physics used, all standard first-order models:
 *  - Propeller: T = Ct·ρ·n²·D⁴, P = Cp·ρ·n³·D⁵. RPM is the lowest of the KV/voltage limit, the
 *    tip-speed limit (Mach 0.62) and the motor power limit. So a big motor on a small prop gains
 *    nothing, and voltage matters.
 *  - Forward flight (rotorcraft): Glauert induced velocity plus parasite drag.
 *  - Fixed wing: parabolic drag polar, CLmax 1.3, propulsive efficiency 0.65.
 *  - Helicopter: momentum theory with figure of merit 0.70 and 10% tail-rotor power.
 *
 * Calibration check (tests/performance.test.ts): a Mavic-3-class spec lands near its published 46 min
 * and 21 m/s. These are estimates, labelled as such everywhere they are shown.
 */
import * as THREE from 'three'
import type { DroneSpec, Rarity } from './types'
import { LAYOUTS, rotorCount, className } from './layouts'
import {
  AVIONICS, CHEMISTRY, FRAME_MATERIALS, HYDROGEN, PROP_MATERIALS, motorById, weaponById, systemById,
  stealthSkin, chuteFor, SYSTEMS, WEAPONS,
} from './parts'
import { batteryMassKg, packVoltage, packWh } from './battery'
import { layoutPoints } from './points'
import { SLOT_CAPS } from '../config'

export const RHO = 1.225
export const G = 9.81
const ETA_ESC = 0.95
/** Small motors are less efficient: ~0.70 at 50 W rising to ~0.84 at 5 kW. */
export function motorEfficiency(maxPowerW: number) {
  return 0.7 + 0.14 * clamp(Math.log10(maxPowerW / 50) / 2, 0, 1)
}
/** Low-Reynolds penalty: small props need more power for the same thrust. */
function smallPropPenalty(D: number) {
  return 1 + 0.35 * Math.max(0, Math.log10(0.25 / D))
}

export type StatKey = 'speed' | 'endurance' | 'agility' | 'accuracy' | 'payload' | 'stealth' | 'durability' | 'range'
export const STAT_KEYS: StatKey[] = ['speed', 'endurance', 'agility', 'accuracy', 'payload', 'stealth', 'durability', 'range']
export const STAT_LABEL: Record<StatKey, string> = {
  speed: 'Speed', endurance: 'Endurance', agility: 'Agility', accuracy: 'Accuracy',
  payload: 'Payload', stealth: 'Stealth', durability: 'Durability', range: 'Range',
}

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface Check { id: string; label: string; status: CheckStatus; value: string; detail: string; fix?: string }

export interface MassItem { label: string; kg: number; pos: THREE.Vector3; group: 'structure' | 'propulsion' | 'energy' | 'avionics' | 'payload' }
export interface PriceItem { label: string; usd: number }

export interface Performance {
  kind: 'ring' | 'wing_ring' | 'wing' | 'heli'
  className: string
  rotors: number
  massKg: number
  massItems: MassItem[]
  cg: THREE.Vector3
  /** Rotorcraft: CG offset from the lift centre as a fraction of L / W. Aeroplanes: static margin. */
  cgOffset: { x: number; y: number; staticMargin: number | null }
  thrust: { perRotorN: number; totalN: number; twr: number; limitedBy: string; rpm: number }
  hover: { powerW: number; currentA: number; rpm: number } | null
  electrical: { packV: number; packWh: number; drawA: number; supplyA: number; peakW: number }
  speed: { max: number; cruise: number; climb: number; stall: number | null }
  endurance: { hoverMin: number | null; bestMin: number; bestSpeed: number }
  range: { km: number; linkKm: number; limited: boolean }
  agility: { tau: number; yawRate: number; score: number }
  accuracy: { score: number; spreadMult: number; holdM: number }
  payloadMarginKg: number
  noiseDb: number
  signature: { rcsM2: number; lidarReflectivity: number; visualM2: number }
  durabilityHp: number
  price: { totalUsd: number; items: PriceItem[] }
  stats: Record<StatKey, number>
  powerScore: number
  rarity: Rarity
  checks: Check[]
  flightReady: boolean
  /** 0..1.4 — weight divided by usable lift. The big balance bar. */
  load: number
  /** Short sentences for the "how to fix" panel. */
  advice: string[]
  /** Numbers the flight simulator needs, so it flies exactly the drone this model describes. */
  aero: { Afront: number; Atop: number; tiltMax: number; wingArea: number; Cd0: number; k: number; vPitch: number; staticThrustN: number }
  power: { hoverW: number; cruiseW: number; auxW: number; usableWh: number }
}

// ───────────────────────────── helpers ─────────────────────────────

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
const fmt = (v: number, d = 1) => v.toFixed(d)

function propCoeffs(blades: number, mat: 'plastic' | 'carbon', D: number) {
  const pm = PROP_MATERIALS[mat]
  return { ct: 0.11 * Math.pow(blades / 2, 0.6) * pm.ct, cp: 0.042 * Math.pow(blades / 2, 0.95) * pm.cp * smallPropPenalty(D) }
}

/** Max static thrust and power for one prop driven by one motor. */
function propMax(D: number, blades: number, mat: 'plastic' | 'carbon', motorId: string, packV: number) {
  const m = motorById(motorId)
  const ETA_MOTOR = motorEfficiency(m.maxPowerW)
  const { ct, cp } = propCoeffs(blades, mat, D)
  const vLoaded = packV * 0.92
  const nKv = (m.kv * vLoaded * 0.85) / 60
  const nTip = (0.62 * 343) / (Math.PI * D)
  const nPow = Math.cbrt((m.maxPowerW * ETA_MOTOR) / (cp * RHO * D ** 5))
  const n = Math.min(nKv, nTip, nPow)
  const limitedBy = n === nPow ? 'motor power' : n === nTip ? 'prop tip speed' : 'motor KV × voltage'
  const T = ct * RHO * n * n * D ** 4
  const Pshaft = cp * RHO * n ** 3 * D ** 5
  return { T, Pshaft, Pelec: Pshaft / (ETA_MOTOR * ETA_ESC), n, limitedBy, ct, cp, eta: ETA_MOTOR }
}

function hoverPerRotor(Treq: number, D: number, ct: number, cp: number) {
  const n = Math.sqrt(Treq / (ct * RHO * D ** 4))
  const P = cp * RHO * n ** 3 * D ** 5
  return { n, Pshaft: P }
}

/** Luminance of an sRGB hex colour, linearised. */
function luminance(hex: string): number {
  const c = new THREE.Color(hex)
  // THREE.Color stores linear components when ColorManagement is on; compute from sRGB explicitly.
  const srgb = c.getHexString()
  const r = parseInt(srgb.slice(0, 2), 16) / 255, g = parseInt(srgb.slice(2, 4), 16) / 255, b = parseInt(srgb.slice(4, 6), 16) / 255
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Reflectivity at 905 nm. Paint colour is a reasonable proxy for near-IR albedo of ordinary coatings. */
export function lidarReflectivity(spec: DroneSpec): number {
  const Y = luminance(spec.livery.primary) * 0.7 + luminance(spec.livery.secondary) * 0.3
  const finish = spec.livery.finish === 'gloss' ? 0.9 : spec.livery.finish === 'satin' ? 1.0 : 1.05
  let rho = (0.04 + 0.78 * Y) * finish
  if (spec.systems.some(s => s.id === 'stealth')) rho *= 0.4
  return clamp(rho, 0.02, 0.92)
}

// ───────────────────────────── the model ─────────────────────────────

export function computePerformance(spec: DroneSpec): Performance {
  const lay = LAYOUTS[spec.layout]
  const kind = lay.kind
  const lp = layoutPoints(spec)
  const S = lp.S
  const { L, W } = S
  const ref = Math.min(L, W)
  const mat = FRAME_MATERIALS[spec.internals.frameMaterial]
  const av = AVIONICS[spec.internals.avionics]
  const motor = motorById(spec.internals.motorId)
  const chem = CHEMISTRY[spec.internals.battery.chemistry]
  const packV = packVoltage(spec)
  const wh = packWh(spec)
  const ah = spec.internals.battery.capacityMah / 1000
  const blades = spec.internals.propBlades
  const propMat = spec.internals.propMaterial
  const D = S.propD
  const ETA_MOTOR = motorEfficiency(motor.maxPowerW)

  const nLiftStations = lay.angles.length
  const nLift = kind === 'wing' || kind === 'heli' ? 0 : nLiftStations * lay.coax
  const nMotors = kind === 'wing' ? 1 : kind === 'heli' ? 1 : kind === 'wing_ring' ? nLift + 1 : nLift

  // ── mass budget with positions (pre-centring frame) ──
  const items: MassItem[] = []
  const push = (label: string, kg: number, pos: THREE.Vector3, group: MassItem['group']) => { if (kg > 0) items.push({ label, kg, pos, group }) }

  const shapeF = { capsule: 1.0, box: 1.1, pod: 1.0, tube: 0.95, wedge: 1.05 }[spec.body.shape]
  const gearF = { none: 1.0, skids: 1.05, legs: 1.1, rails: 1.14 }[spec.body.gear]
  if (kind === 'ring') {
    const frame = 1.6 * Math.pow(L * W, 1.25) * mat.massFactor * shapeF * gearF
    push('Body shell', frame * 0.55, lp.bodyCenter.clone(), 'structure')
    push('Arms', frame * 0.45, lp.thrustCenter.clone(), 'structure')
  } else if (kind === 'heli') {
    const frame = (0.9 * Math.pow(L, 1.6) + 0.15 * W) * mat.massFactor * gearF
    push('Cabin and boom', frame, new THREE.Vector3(lp.bodyCenter.x - S.bodyL * 0.2, 0, 0), 'structure')
  } else {
    const wn = lp.wing!
    const wingKg = 2.1 * wn.area * mat.massFactor
    const fus = 0.9 * L * (S.bodyW + S.bodyH) * mat.massFactor * shapeF * gearF
    push('Wing', wingKg, new THREE.Vector3(wn.qcX - wn.mac * 0.15, 0, 0), 'structure')
    push('Fuselage', fus, lp.bodyCenter.clone(), 'structure')
    if (spec.body.tail !== 'none') push('Tail surfaces', 0.35 * wn.area * 0.3 * S.tailScale * mat.massFactor, new THREE.Vector3(lp.tailX, 0, 0), 'structure')
    if (kind === 'wing_ring') push('Lift booms', 0.25 * L * mat.massFactor * Math.max(ref, 0.3), lp.thrustCenter.clone(), 'structure')
  }

  // propulsion
  const propKg = (d: number, b: number) => 0.2 * d * d * Math.pow(b / 2, 0.7) * PROP_MATERIALS[propMat].massFactor
  const escKg = 0.003 + motor.maxPowerW * 0.000018
  if (kind === 'heli') {
    push('Main motor + gearbox', motor.massKg * 1.25, lp.thrustCenter.clone().setZ(0), 'propulsion')
    push('Rotor head + blades', 0.35 * W * W * Math.pow(Math.max(blades, 2) / 2, 0.7) + 0.05, lp.thrustCenter.clone(), 'propulsion')
    push('Tail drive', 0.06 + 0.08 * W, new THREE.Vector3(-L / 2 + W * 0.09, 0, 0), 'propulsion')
    push('ESC', escKg, lp.bodyCenter.clone(), 'propulsion')
  } else if (kind === 'wing') {
    const px = spec.body.thrust === 'nose' ? S.bodyL / 2 : -S.bodyL / 2
    push('Motor', motor.massKg, new THREE.Vector3(px, 0, 0), 'propulsion')
    push('Propeller', propKg(D, blades), new THREE.Vector3(px, 0, 0), 'propulsion')
    push('ESC', escKg, lp.bodyCenter.clone(), 'propulsion')
  } else {
    for (const st of lp.stations) {
      const p = new THREE.Vector3(st.x, st.y, S.bodyH * 0.06)
      push(`Motor ${st.tag}`, motor.massKg * lay.coax, p, 'propulsion')
      push(`Prop ${st.tag}`, propKg(D, blades) * lay.coax, p, 'propulsion')
      push(`ESC ${st.tag}`, escKg * lay.coax, p, 'propulsion')
    }
    if (kind === 'wing_ring') {
      const px = -S.bodyL / 2
      push('Cruise motor', motor.massKg, new THREE.Vector3(px, 0, 0), 'propulsion')
      push('Cruise prop', propKg(D, 2), new THREE.Vector3(px, 0, 0), 'propulsion')
    }
  }

  // energy
  const battKg = batteryMassKg(spec)
  push(`${chem.label} ${spec.internals.battery.cells}S ${spec.internals.battery.capacityMah} mAh`, battKg, lp.batteryCenter.clone(), 'energy')

  // avionics, camera, extras
  push(av.label, av.massKg, lp.bodyCenter.clone(), 'avionics')
  const usesNose = [...spec.weapons, ...spec.systems].some(m => m.mount === 'nose')
  if (spec.body.gimbal && !usesNose) push('Gimbal camera', 0.04 + 0.35 * Math.pow(ref, 1.5), lp.hardpoints.nose.clone(), 'avionics')
  if (spec.body.gpsMast) push('GPS mast', 0.02 + 0.02 * ref, new THREE.Vector3(lp.bodyCenter.x - S.bodyL * 0.3, 0, S.bodyH), 'avionics')
  if (spec.body.antennas) push('Antennas', 0.008 * spec.body.antennas, new THREE.Vector3(lp.bodyCenter.x - S.bodyL * 0.4, 0, 0), 'avionics')

  // loadout
  for (const m of lp.modules) {
    const def = m.kind === 'weapon' ? weaponById(m.id) : systemById(m.id)
    if (!def) continue
    push(def.name, def.massKg, m.center.clone(), 'payload')
  }
  if (spec.systems.some(s => s.id === 'stealth')) {
    push('RAM stealth skin', stealthSkin(L, W).massKg, lp.bodyCenter.clone(), 'payload')
  }

  // wiring and fasteners
  const sub = items.reduce((a, i) => a + i.kg, 0)
  push('Wiring, fasteners', sub * 0.04, lp.bodyCenter.clone(), 'structure')
  // the chute's own mass depends on what it must lower
  if (spec.systems.some(s => s.id === 'parachute')) {
    const tot = items.reduce((a, i) => a + i.kg, 0)
    const chuteIdx = items.findIndex(i => i.label.startsWith('PR-2'))
    if (chuteIdx >= 0) items[chuteIdx].kg = chuteFor(tot).massKg
  }

  const massKg = items.reduce((a, i) => a + i.kg, 0)
  const cg = items.reduce((a, i) => a.addScaledVector(i.pos, i.kg), new THREE.Vector3()).divideScalar(massKg)
  const weight = massKg * G

  // ── thrust ──
  let perRotorN = 0, totalN = 0, limitedBy = '', rpmMax = 0, pElecMaxPerRotor = 0
  let ct = 0, cp = 0
  if (kind === 'heli') {
    const A = Math.PI * (W / 2) ** 2
    const Pavail = motor.maxPowerW * ETA_MOTOR * 0.9
    totalN = Math.pow(Pavail * 0.7 * Math.sqrt(2 * RHO * A), 2 / 3)
    perRotorN = totalN
    limitedBy = 'motor power'
    rpmMax = (0.55 * 343 * 60) / (Math.PI * W)
    pElecMaxPerRotor = motor.maxPowerW / ETA_ESC
  } else {
    const pm = propMax(D, blades, propMat, motor.id, packV)
    ct = pm.ct; cp = pm.cp
    perRotorN = pm.T
    limitedBy = pm.limitedBy
    rpmMax = pm.n * 60
    pElecMaxPerRotor = pm.Pelec
    if (kind === 'wing') totalN = pm.T
    else totalN = pm.T * nLiftStations * (lay.coax === 2 ? 1.6 : 1)
  }
  // voltage window
  const s = spec.internals.battery.cells
  const overVolt = s > motor.maxS
  const underVolt = s < motor.minS
  const twr = totalN / weight

  // ── drag areas ──
  const moduleDrag = [...spec.weapons, ...spec.systems].reduce((a, m) => a + ((weaponById(m.id) ?? systemById(m.id))?.dragM2 ?? 0), 0)
  const gimbalDrag = spec.body.gimbal ? S.gimbalW * S.gimbalH : 0
  const gearDrag = spec.body.gear === 'none' ? 0 : S.bodyL * 0.02 + (spec.body.gear === 'skids' ? 0 : S.gearH * S.bodyW * 0.2)
  const bodyFront = S.bodyW * S.bodyH * 0.8
  const armFront = kind === 'ring' ? lp.stations.reduce((a, st) => a + Math.hypot(st.x, st.y) * S.armRoot * 2 * 0.5, 0) : 0
  const motorFront = nLift * 2 * S.motorR * S.motorH
  const Afront = bodyFront + armFront + motorFront + moduleDrag + gimbalDrag + gearDrag
  const Atop = kind === 'ring' ? L * W * 0.35 : S.bodyL * S.bodyW

  // ── speed, power, endurance ──
  const usableWh = wh * (spec.internals.battery.chemistry === 'hydrogen' ? 0.95 : 0.85)
  const payloadW = [...spec.weapons].reduce((a, m) => a + (weaponById(m.id)?.powerW ?? 0) * 0.3, 0)
    + [...spec.systems].reduce((a, m) => a + (systemById(m.id)?.powerW ?? 0), 0)
  const auxW = av.powerW + payloadW + (spec.body.gimbal ? 3 : 0)
  const peakPayloadW = [...spec.weapons].reduce((a, m) => a + (weaponById(m.id)?.powerW ?? 0), 0)
    + [...spec.systems].reduce((a, m) => a + (systemById(m.id)?.powerW ?? 0), 0)

  let vmax = 0, cruise = 0, climb = 0, stall: number | null = null
  let tiltUsed = 0, cruiseW = 0
  let wingAero = { S: 0, Cd0: 0, k: 0, vPitch: 0, T0: 0 }
  let hover: Performance['hover'] = null
  let bestMin = 0, bestSpeed = 0, rangeKm = 0, hoverMin: number | null = null
  const twrUsable = twr > 1.02

  if (kind === 'ring' || kind === 'heli' || kind === 'wing_ring') {
    // hover
    let PhoverShaft = 0, nHover = 0
    const Atot = kind === 'heli' ? Math.PI * (W / 2) ** 2 : nLift * Math.PI * (D / 2) ** 2
    if (kind === 'heli') {
      PhoverShaft = Math.pow(weight, 1.5) / (0.7 * Math.sqrt(2 * RHO * Atot)) / 0.9
      nHover = Math.sqrt(weight / (Atot * 2 * RHO)) // induced velocity proxy, not rpm
    } else {
      // Coaxial pairs: the lower rotor works in the upper one's wake, costing about 22% more power.
      const Tper = weight / nLift
      const h = hoverPerRotor(Tper, D, ct, cp)
      PhoverShaft = h.Pshaft * nLift * (lay.coax === 2 ? 1.22 : 1)
      nHover = h.n
    }
    const PhoverElec = PhoverShaft / (ETA_MOTOR * ETA_ESC) + auxW
    hover = { powerW: PhoverElec, currentA: PhoverElec / (packV * 0.95), rpm: kind === 'heli' ? 0 : nHover * 60 }
    hoverMin = twrUsable ? (usableWh / PhoverElec) * 60 : 0

    // max speed from the tilt limit
    const tiltCap = (kind === 'heli' ? 30 : av.maxTiltDeg) * Math.PI / 180
    const tiltPhys = twrUsable ? Math.acos(clamp(1 / twr, 0, 1)) : 0
    const tilt = Math.min(tiltCap, tiltPhys * 0.92)
    tiltUsed = tilt
    const Aeff = Afront * Math.cos(tilt) + Atop * Math.sin(tilt)
    vmax = twrUsable ? Math.sqrt((2 * weight * Math.tan(tilt)) / (RHO * 1.0 * Math.max(Aeff, 1e-4))) : 0
    climb = twrUsable ? Math.min(Math.sqrt((2 * (totalN - weight)) / (RHO * 1.2 * Math.max(Atop, 1e-4))), Math.max(vmax * 0.6, 1)) : 0

    // forward-flight power curve → best endurance and best range speeds
    const vh = Math.sqrt(weight / (2 * RHO * Math.max(Atot, 1e-6)))
    const FMh = (weight * vh) / Math.max(PhoverShaft, 1e-6)
    let bestP = Infinity, bestR = 0
    for (let i = 0; i <= 60; i++) {
      const v = (vmax * i) / 60
      const Dg = 0.5 * RHO * v * v * Afront
      const T = Math.hypot(weight, Dg)
      const vi = (vh * vh) / Math.sqrt(v * v + vh * vh)
      const Pshaft = (T * vi) / FMh + Dg * v
      const Pe = Pshaft / (ETA_MOTOR * ETA_ESC) + auxW
      if (Pe < bestP) { bestP = Pe; bestSpeed = v }
      if (v > 0.5 && v / Pe > bestR) { bestR = v / Pe; cruise = v }
    }
    bestMin = twrUsable ? (usableWh / bestP) * 60 : 0
    rangeKm = twrUsable ? (usableWh * 3600 * bestR) / 1000 * 0.9 : 0

    if (kind === 'wing_ring') {
      // VTOL: cruise on the wing; two 45 s hover phases come off the top.
      const fw = wingCruise(spec, lp, massKg, Afront, moduleDrag + gimbalDrag + gearDrag, auxW, D, blades, propMat, motor.id, packV)
      wingAero = fw; cruiseW = fw.Pcruise
      vmax = Math.max(vmax, fw.vmax)
      stall = fw.stall
      cruise = fw.cruise
      const hoverWh = (PhoverElec * 90) / 3600
      const cruiseWh = Math.max(usableWh - hoverWh, 0)
      bestMin = 1.5 + (cruiseWh / fw.Pend) * 60
      bestSpeed = fw.vend
      rangeKm = (cruiseWh * 3600 * (fw.cruise / fw.Pcruise)) / 1000 * 0.9
    }
  } else {
    const fw = wingCruise(spec, lp, massKg, Afront, moduleDrag + gimbalDrag + gearDrag, auxW, D, blades, propMat, motor.id, packV)
    wingAero = fw; cruiseW = fw.Pcruise
    vmax = fw.vmax
    stall = fw.stall
    cruise = fw.cruise
    climb = fw.climb
    bestMin = fw.Pend > 0 ? (usableWh / fw.Pend) * 60 : 0
    bestSpeed = fw.vend
    rangeKm = (usableWh * 3600 * (fw.cruise / Math.max(fw.Pcruise, 1e-6))) / 1000 * 0.9
  }
  const linkKm = av.linkKm
  const range = { km: rangeKm, linkKm, limited: rangeKm / 2 > linkKm }

  // ── electrical ──
  const peakW = (kind === 'wing' || kind === 'heli' ? pElecMaxPerRotor : pElecMaxPerRotor * nLift) + av.powerW + peakPayloadW
  const drawA = peakW / (packV * 0.92)
  const supplyA = spec.internals.battery.chemistry === 'hydrogen'
    ? (HYDROGEN.basePowerW + HYDROGEN.powerPerWh * wh) / packV
    : chem.maxC * ah

  // ── agility ──
  const sizeF = Math.pow(Math.max(L, 0.08), 0.7)
  let tau: number
  if (kind === 'wing') tau = clamp(0.22 + 0.14 * sizeF, 0.2, 0.75)
  else tau = clamp(0.06 + (0.12 * sizeF) / Math.sqrt(Math.max(twr - 1, 0.2)), 0.06, 0.6)
  const yawRate = kind === 'wing' ? 0 : clamp((300 / (1 + L)) * clamp(twr - 1, 0.2, 1), 25, 400)
  const agilityScore = clamp(((0.5 - tau) / 0.44) * 100, 0, 100)

  // ── accuracy ──
  let acc = av.accuracy + clamp(6 * Math.log10(massKg / 0.5), -8, 10)
  if (twr > 4) acc -= (twr - 4) * 2
  if (twr < 1.6) acc -= (1.6 - twr) * 40
  const kin = spec.weapons.find(w => w.id === 'kinetic')
  if (kin) {
    const st = weaponById('kinetic')!.stats
    const recoilN = Number(st.recoil) * Number(st.rate)
    acc -= Math.min(22, (recoilN / weight) * 34)
  }
  if (kind === 'wing') acc -= 6 // aeroplanes cannot hover-aim
  acc = clamp(acc, 5, 99)
  const spreadMult = 1 + (100 - acc) / 60

  // ── payload margin ──
  const payloadMarginKg = kind === 'wing'
    ? Math.max(0, (0.5 * RHO * (cruise || 15) ** 2 * (lp.wing?.area ?? 0.2) * 1.3) / (1.3 * 1.3) / G - massKg)
    : totalN / (2.0 * G) - massKg

  // ── noise ──
  const tip = kind === 'heli' ? 180 : Math.PI * D * ((hover?.rpm ?? rpmMax * 0.6) / 60)
  const Pnoise = hover?.powerW ?? (cruise * weight) / 8
  const noiseDb = clamp(45 + 10 * Math.log10(Math.max(Pnoise, 1)) + 25 * Math.log10(Math.max(tip, 20) / 150), 35, 115)

  // ── signatures ──
  const stealth = spec.systems.some(x => x.id === 'stealth')
  const metal = spec.weapons.length * 0.012 + spec.systems.filter(x => x.id !== 'stealth').length * 0.006
  const rcsM2 = ((Afront + Atop * 0.4) * mat.rcs + metal) * (stealth ? 0.3 : 1)
  const rho905 = lidarReflectivity(spec)
  const visualM2 = Afront + Atop * 0.5

  // ── durability ──
  const durabilityHp = Math.round(clamp(100 * mat.durability * (1 + 0.35 * Math.log10(massKg / 0.5 + 1)), 30, 260))

  // ── price ──
  const price: PriceItem[] = []
  const P = (label: string, usd: number) => { if (usd > 0) price.push({ label, usd: Math.round(usd) }) }
  if (kind === 'ring' || kind === 'heli') P(`${mat.label} airframe`, (40 + 900 * Math.pow(L * W, 1.1)) * mat.priceFactor)
  else P(`${mat.label} airframe`, (60 + 650 * Math.pow(lp.wing!.area, 1.1) + 300 * L * (S.bodyW + S.bodyH)) * mat.priceFactor)
  P(`${nMotors}× ${motor.label}`, motor.priceUsd * nMotors * (kind === 'heli' ? 1.6 : 1))
  const nProps = kind === 'heli' ? 1 : kind === 'wing' ? 1 : nLift + (kind === 'wing_ring' ? 1 : 0)
  P(`${nProps}× props (${blades}-blade)`, nProps * (2 + 40 * D * D) * PROP_MATERIALS[propMat].priceFactor * (blades / 2) * (kind === 'heli' ? 12 : 1))
  P(`${nMotors}× ESC`, nMotors * (8 + 0.03 * motor.maxPowerW))
  P(`Battery ${fmt(wh, 0)} Wh`, wh * chem.usdPerWh + 10 + (spec.internals.battery.chemistry === 'hydrogen' ? HYDROGEN.stackUsd : 0))
  P(av.label, av.priceUsd)
  if (spec.body.gimbal && !usesNose) P('Gimbal camera', 120 + 900 * ref)
  for (const m of [...spec.weapons, ...spec.systems]) {
    if (m.id === 'stealth') { P('RAM stealth skin', stealthSkin(L, W).priceUsd); continue }
    if (m.id === 'parachute') { P('PR-2 Recovery Chute', chuteFor(massKg).priceUsd); continue }
    const def = weaponById(m.id) ?? systemById(m.id)
    if (def) P(def.name, def.priceUsd)
  }
  const subtotal = price.reduce((a, i) => a + i.usd, 0)
  P('Assembly and integration', subtotal * 0.12)
  const totalUsd = price.reduce((a, i) => a + i.usd, 0)

  // ── stats 0..100 ──
  const radarScore = clamp(100 - 20 * Math.log10(Math.max(rcsM2, 1e-4) / 0.001), 0, 100)
  const lidarScore = clamp(100 * (1 - rho905 / 0.8), 0, 100)
  const acousticScore = clamp(100 - (noiseDb - 45) * 1.6, 0, 100)
  const stats: Record<StatKey, number> = {
    speed: clamp((vmax / 45) * 100, 0, 100),
    endurance: clamp((bestMin / 60) * 100, 0, 100),
    agility: kind === 'wing' ? clamp(agilityScore * 0.7, 0, 100) : agilityScore,
    accuracy: acc,
    payload: clamp((100 * Math.log10(1 + Math.max(payloadMarginKg, 0))) / Math.log10(21), 0, 100),
    stealth: 0.5 * radarScore + 0.3 * lidarScore + 0.2 * acousticScore,
    durability: clamp(durabilityHp / 2, 0, 100),
    range: clamp((100 * Math.log10(1 + Math.min(rangeKm / 2, linkKm))) / Math.log10(101), 0, 100),
  }
  const loadoutBonus = (spec.weapons.length + spec.systems.length) * 4
  const powerScore = Math.round(clamp(STAT_KEYS.reduce((a, k) => a + stats[k], 0) / STAT_KEYS.length + loadoutBonus, 0, 100))
  const rarity: Rarity = powerScore >= 78 ? 'legendary' : powerScore >= 66 ? 'epic' : powerScore >= 54 ? 'rare' : powerScore >= 42 ? 'uncommon' : 'common'

  // ── balance checks ──
  const checks: Check[] = []
  const advice: string[] = []
  const minTwr = kind === 'wing' ? 0.35 : 1.6
  const load = kind === 'wing' ? clamp(minTwr / Math.max(twr, 1e-3), 0, 1.5) : clamp(weight / Math.max(totalN / minTwr, 1e-6), 0, 1.5)
  {
    const st: CheckStatus = kind === 'wing'
      ? (twr >= 0.45 ? 'ok' : twr >= 0.3 ? 'warn' : 'fail')
      : (twr >= 2.0 ? 'ok' : twr >= 1.6 ? 'warn' : 'fail')
    checks.push({
      id: 'lift', label: kind === 'wing' ? 'Thrust' : 'Lift', status: st,
      value: `${fmt(twr, 2)} : 1`,
      detail: kind === 'wing'
        ? `Static thrust is ${fmt(twr * 100, 0)}% of weight. Hand-launch needs about 35%; 45%+ climbs well.`
        : `Full thrust is ${fmt(twr, 2)}× the weight. Below 1.6 it cannot manoeuvre safely; 2.0+ is comfortable.`,
      fix: st === 'ok' ? undefined : 'Shed weight, use a stronger motor class, more blades, or a higher-voltage pack.',
    })
    if (st !== 'ok') advice.push(kind === 'wing' ? 'More thrust: bigger motor or more cells.' : 'Too heavy for its lift: lighten it or add thrust.')
  }
  {
    const r = drawA / Math.max(supplyA, 1e-6)
    const st: CheckStatus = r <= 0.8 ? 'ok' : r <= 1.0 ? 'warn' : 'fail'
    checks.push({
      id: 'power', label: 'Power', status: st, value: `${fmt(drawA, 0)} A / ${fmt(supplyA, 0)} A`,
      detail: spec.internals.battery.chemistry === 'hydrogen'
        ? `Peak demand ${fmt(peakW, 0)} W against the fuel cell's ${fmt(supplyA * packV, 0)} W continuous.`
        : `Full-throttle draw against the pack's ${chem.maxC}C limit.`,
      fix: st === 'ok' ? undefined : 'Bigger capacity, a higher-C chemistry (LiPo), or fewer power-hungry modules.',
    })
    if (st !== 'ok') advice.push('The battery cannot supply full throttle: raise capacity or switch to LiPo.')
  }
  {
    let st: CheckStatus = 'ok', value = '', detail = ''
    if (kind === 'wing') {
      const sm = lp.neutralPointX != null && lp.wing ? (cg.x - lp.neutralPointX) / lp.wing.mac : 0
      st = sm >= 0.05 && sm <= 0.2 ? 'ok' : sm >= 0 && sm <= 0.3 ? 'warn' : 'fail'
      value = `${fmt(sm * 100, 0)}% MAC`
      detail = 'Static margin: how far the CG sits ahead of the neutral point. 5–20% flies; negative is unstable.'
    } else {
      const dx = (cg.x - lp.thrustCenter.x) / L
      const dy = (cg.y - lp.thrustCenter.y) / W
      const m = Math.max(Math.abs(dx), Math.abs(dy))
      st = m <= 0.03 ? 'ok' : m <= 0.06 ? 'warn' : 'fail'
      value = `${dx >= 0 ? '+' : ''}${fmt(dx * 100, 1)}% fwd · ${dy >= 0 ? '+' : ''}${fmt(dy * 100, 1)}% left`
      detail = 'Centre of gravity versus the centre of lift. Over 3% and the motors fight to hold level; over 6% it will not fly.'
    }
    checks.push({ id: 'cg', label: 'Balance', status: st, value, detail, fix: st === 'ok' ? undefined : 'Slide the battery, or move modules to opposite mounts.' })
    if (st !== 'ok') advice.push('Out of balance: slide the battery or move a module.')
  }
  {
    const st: CheckStatus = overVolt ? 'fail' : underVolt ? 'warn' : 'ok'
    checks.push({
      id: 'voltage', label: 'Voltage', status: st, value: `${s}S on ${motor.minS}–${motor.maxS}S motors`,
      detail: overVolt ? 'Over-volted: these motors would overheat and fail.' : underVolt ? 'Under-volted: the motors never reach full speed.' : 'Pack voltage matches the motors.',
      fix: st === 'ok' ? undefined : `Use ${motor.minS === motor.maxS ? motor.minS : `${motor.minS}–${motor.maxS}`} cells.`,
    })
    if (st !== 'ok') advice.push(`Match the pack to the motors: ${motor.minS}–${motor.maxS}S.`)
  }
  {
    const mid = (motor.propM[0] + motor.propM[1]) / 2
    const r = D / mid
    const st: CheckStatus = r >= 0.7 && r <= 1.4 ? 'ok' : r >= 0.5 && r <= 1.8 ? 'warn' : 'fail'
    if (kind !== 'heli') {
      checks.push({
        id: 'match', label: 'Motor ↔ prop', status: st,
        value: `${fmt(D * 39.37, 1)}″ prop on a ${fmt(motor.propM[0] * 39.37, 0)}–${fmt(motor.propM[1] * 39.37, 0)}″ motor`,
        detail: r < 1 ? 'A motor built for bigger props wastes its mass here.' : r > 1 ? 'This prop overloads a motor built for smaller props.' : 'Well matched.',
        fix: st === 'ok' ? undefined : 'Pick the motor class suggested for this prop size.',
      })
      if (st !== 'ok') advice.push('Pick a motor sized for this propeller.')
    }
  }
  {
    const w = spec.weapons.length, sy = spec.systems.length
    const mounts = [...spec.weapons, ...spec.systems].filter(m => m.id !== 'stealth').map(m => m.mount)
    const clash = mounts.length !== new Set(mounts).size
    const st: CheckStatus = w > SLOT_CAPS.weapons || sy > SLOT_CAPS.systems || clash ? 'fail' : 'ok'
    checks.push({
      id: 'slots', label: 'Loadout', status: st, value: `${w}/${SLOT_CAPS.weapons} weapons · ${sy}/${SLOT_CAPS.systems} systems`,
      detail: clash ? 'Two modules share a mount. Each mount holds one module.' : `Up to ${SLOT_CAPS.weapons} weapons and ${SLOT_CAPS.systems} special systems.`,
      fix: clash ? 'Move one module to a free mount.' : undefined,
    })
    if (clash) advice.push('Two modules share a mount.')
  }
  if (!lp.feasible) {
    checks.push({
      id: 'fit', label: 'Rotor fit', status: 'fail', value: `${fmt(lp.residual * 1000, 0)} mm over`,
      detail: 'The rotor diameter is bigger than the envelope allows.', fix: 'Reduce the rotor size.',
    })
    advice.push('Rotors are too large for the frame.')
  }
  if (stall != null && vmax > 0 && vmax < stall * 1.25) {
    checks.push({
      id: 'stall', label: 'Speed margin', status: vmax < stall ? 'fail' : 'warn',
      value: `${fmt(vmax, 1)} vs stall ${fmt(stall, 1)} m/s`,
      detail: 'Top speed must comfortably exceed stall speed.', fix: 'Bigger wing, less weight, or more thrust.',
    })
  }
  const flightReady = checks.every(c => c.status !== 'fail')

  return {
    kind, className: className(spec.layout), rotors: rotorCount(spec.layout),
    massKg, massItems: items, cg,
    cgOffset: {
      x: (cg.x - lp.thrustCenter.x) / L, y: (cg.y - lp.thrustCenter.y) / W,
      staticMargin: kind === 'wing' && lp.neutralPointX != null && lp.wing ? (cg.x - lp.neutralPointX) / lp.wing.mac : null,
    },
    thrust: { perRotorN, totalN, twr, limitedBy, rpm: rpmMax },
    hover,
    electrical: { packV, packWh: wh, drawA, supplyA, peakW },
    speed: { max: vmax, cruise, climb, stall },
    endurance: { hoverMin, bestMin, bestSpeed },
    range,
    agility: { tau, yawRate, score: agilityScore },
    accuracy: { score: acc, spreadMult, holdM: (100 - acc) / 40 },
    payloadMarginKg,
    noiseDb,
    signature: { rcsM2, lidarReflectivity: rho905, visualM2 },
    durabilityHp,
    price: { totalUsd, items: price },
    stats, powerScore, rarity, checks, flightReady, load, advice,
    aero: { Afront, Atop, tiltMax: tiltUsed, wingArea: wingAero.S, Cd0: wingAero.Cd0, k: wingAero.k, vPitch: wingAero.vPitch, staticThrustN: wingAero.T0 },
    power: { hoverW: hover?.powerW ?? 0, cruiseW: cruiseW || (hover?.powerW ?? 0), auxW, usableWh },
  }
}

/** Fixed-wing cruise numbers from a parabolic drag polar. */
function wingCruise(
  spec: DroneSpec, lp: ReturnType<typeof layoutPoints>, massKg: number, _Afront: number, extraDrag: number, auxW: number,
  D: number, blades: number, propMat: 'plastic' | 'carbon', motorId: string, packV: number,
) {
  const wn = lp.wing!
  const S = Math.max(wn.area, 1e-3)
  const AR = wn.aspect
  const e = 0.8
  const k = 1 / (Math.PI * e * AR)
  const Cd0 = 0.03 + extraDrag / S + (spec.body.gear === 'none' ? 0 : 0.01)
  const weight = massKg * G
  const stall = Math.sqrt((2 * weight) / (RHO * S * 1.3))
  const pm = propMax(D, blades, propMat, motorId, packV)
  const vPitch = Math.max(pm.n * 0.8 * D, 5)
  const drag = (v: number) => 0.5 * RHO * v * v * S * Cd0 + (weight * weight) / (0.5 * RHO * v * v * S) * k
  const thrustAt = (v: number) => pm.T * Math.max(0, 1 - v / vPitch)
  // top speed: where thrust meets drag
  let vmax = 0
  for (let v = stall; v < 120; v += 0.25) { if (thrustAt(v) >= drag(v)) vmax = v; else if (vmax > 0) break }
  const etaProp = 0.65
  const powerAt = (v: number) => (drag(v) * v) / (etaProp * pm.eta * ETA_ESC) + auxW
  const vmd = Math.sqrt((2 * weight) / (RHO * S)) * Math.pow(k / Cd0, 0.25) // min drag = best range
  const cruise = Math.max(vmd, stall * 1.25)
  const vend = Math.max(vmd * 0.76, stall * 1.15) // min power = best endurance
  const climbExcess = (thrustAt(cruise) - drag(cruise)) * cruise / weight
  return {
    vmax: vmax || 0, stall, cruise, vend,
    Pcruise: powerAt(cruise), Pend: powerAt(vend),
    climb: Math.max(climbExcess, 0),
    S, Cd0, k, vPitch, T0: pm.T,
  }
}

/** Compact numbers saved alongside a drone so lists render without rerunning physics. */
export function summarise(spec: DroneSpec) {
  const p = computePerformance(spec)
  return {
    massKg: +p.massKg.toFixed(3), priceUsd: p.price.totalUsd, maxSpeed: +p.speed.max.toFixed(1),
    endurance: +p.endurance.bestMin.toFixed(1), powerScore: p.powerScore, rarity: p.rarity, className: p.className,
  }
}

/** Slide the battery to put the CG on the lift centre (rotorcraft) or at 12% static margin. */
export function autoBalance(spec: DroneSpec): DroneSpec {
  const kind = LAYOUTS[spec.layout].kind
  const target = (p: Performance) => (kind === 'wing' ? (p.cgOffset.staticMargin ?? 0) - 0.12 : p.cgOffset.x)
  let lo = -1, hi = 1
  const at = (pos: number) => target(computePerformance({ ...spec, internals: { ...spec.internals, battery: { ...spec.internals.battery, position: pos } } }))
  const fLo = at(lo), fHi = at(hi)
  if (Math.sign(fLo) === Math.sign(fHi)) {
    const pos = Math.abs(fLo) < Math.abs(fHi) ? lo : hi
    return { ...spec, internals: { ...spec.internals, battery: { ...spec.internals.battery, position: pos } } }
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (Math.sign(at(mid)) === Math.sign(fLo)) lo = mid
    else hi = mid
  }
  const pos = +((lo + hi) / 2).toFixed(3)
  return { ...spec, internals: { ...spec.internals, battery: { ...spec.internals.battery, position: pos } } }
}

export const ALL_MODULES = [...WEAPONS, ...SYSTEMS]
