/**
 * Resolve a spec's proportional ratios into absolute metres, and build sensible defaults.
 */
import type { DroneSpec, LayoutId, ShapeRatios } from './types'
import { LAYOUTS, defaultRatios, rotorCount } from './layouts'
import { motorForProp } from './parts'

export interface Shape {
  layout: LayoutId
  kind: 'ring' | 'wing_ring' | 'wing' | 'heli'
  L: number
  W: number
  Htarget: number | null
  propD: number
  bladeCount: number
  bladeChord: number
  bladeThick: number
  armRoot: number
  armTip: number
  motorR: number
  motorH: number
  hubH: number
  gimbalW: number
  gimbalH: number
  gearH: number
  bodyL: number
  bodyW: number
  bodyH: number
  wingRoot: number
  wingTip: number
  wingThick: number
  wingSweep: number
  wingDihedral: number
  tailScale: number
}

export function resolveShape(spec: DroneSpec, override?: Partial<Shape>): Shape {
  const r = spec.ratios
  const { length: L, width: W } = spec.envelope
  const ref = Math.min(L, W)
  const kind = LAYOUTS[spec.layout].kind
  const propD = spec.rotorDiameterOverride ?? r.rotor * ref
  const s: Shape = {
    layout: spec.layout,
    kind,
    L, W,
    Htarget: spec.heightLocked ? spec.envelope.height : null,
    propD,
    bladeCount: spec.internals.propBlades,
    bladeChord: r.bladeChord * ref * (kind === 'heli' ? 0.55 : 1),
    bladeThick: Math.max(0.0015, 0.012 * r.bladeChord * ref * 1.6),
    armRoot: r.armR * ref,
    armTip: r.armR * ref * 0.71,
    motorR: r.motorR * ref,
    motorH: r.motorH * ref,
    hubH: r.motorH * ref * 0.33,
    gimbalW: 0.107 * ref,
    gimbalH: 0.070 * ref,
    gearH: r.gearH * L,
    bodyL: r.bodyL * L,
    bodyW: r.bodyW * L,
    bodyH: r.bodyH * L,
    wingRoot: r.wingRoot * L,
    wingTip: r.wingTip * L,
    wingThick: r.wingThick * L,
    wingSweep: r.wingSweep * L,
    wingDihedral: r.wingDihedral * W,
    tailScale: r.tailScale,
  }
  return { ...s, ...override }
}

/** Reasonable starting spec for any layout at a given size. */
export function defaultSpec(layout: LayoutId, L: number, W: number, name = 'New drone'): DroneSpec {
  const ratios: ShapeRatios = defaultRatios(layout)
  const kind = LAYOUTS[layout].kind
  const ref = Math.min(L, W)
  const propD = ratios.rotor * ref
  const wing = kind === 'wing' || kind === 'wing_ring'
  const motor = motorForProp(kind === 'heli' ? propD * 0.5 : wing && kind === 'wing' ? propD : propD)
  // Rough energy sizing: bigger airframes get proportionally bigger packs.
  const size = L * W
  const cells = Math.min(Math.max(motor.minS, 1), motor.maxS)
  const capacity = Math.round(Math.max(450, Math.min(42000, 22000 * Math.pow(size, 0.95))) / 50) * 50
  return {
    version: 3,
    name,
    origin: 'design',
    layout,
    envelope: { length: L, width: W, height: 0 },
    heightLocked: false,
    ratios,
    body: {
      shape: wing ? 'tube' : kind === 'heli' ? 'pod' : 'capsule',
      gear: wing ? 'none' : kind === 'heli' ? 'rails' : 'skids',
      tail: wing ? 'conventional' : 'none',
      thrust: 'nose',
      gpsMast: false,
      antennas: 0,
      gimbal: true,
    },
    internals: {
      frameMaterial: 'carbon',
      motorId: motor.id,
      propBlades: kind === 'heli' ? 4 : wing && kind === 'wing' ? 2 : rotorCount(layout) >= 6 ? 2 : 3,
      propMaterial: 'plastic',
      battery: { chemistry: wing ? 'liion' : 'lipo', cells, capacityMah: capacity, position: 0 },
      avionics: size > 0.4 ? 'pro' : 'hobby',
    },
    weapons: [],
    systems: [],
    livery: { primary: '#C9D1D9', secondary: '#2B3540', accent: '#FF6B2C', finish: 'satin', pattern: 'split' },
  }
}

/** Typical sizes by class, used by the "start from a template" picker. */
export const SIZE_PRESETS: { id: string; label: string; L: number; W: number; note: string }[] = [
  { id: 'micro', label: 'Micro', L: 0.13, W: 0.13, note: 'Palm-sized, under 100 g' },
  { id: 'compact', label: 'Compact', L: 0.30, W: 0.36, note: 'Foldable camera drone' },
  { id: 'pro', label: 'Pro', L: 0.62, W: 0.62, note: 'Inspection and survey' },
  { id: 'heavy', label: 'Heavy', L: 1.2, W: 1.2, note: 'Cinema, payload, industrial' },
  { id: 'cargo', label: 'Cargo', L: 2.2, W: 2.2, note: 'Delivery and agriculture' },
]

export const WING_PRESETS: { id: string; label: string; L: number; W: number; note: string }[] = [
  { id: 'hand', label: 'Hand-launch', L: 0.9, W: 1.4, note: 'Backpack ISR class' },
  { id: 'survey', label: 'Survey', L: 1.2, W: 2.2, note: 'Mapping and long range' },
  { id: 'tactical', label: 'Tactical', L: 2.0, W: 3.6, note: 'Long endurance' },
]
