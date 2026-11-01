/**
 * Shared engine types. Coordinate contract (locked, same as the Python pipeline and Gazebo):
 *   X forward, Y left, Z up. Metres. Origin at the centre of the assembled bounding box.
 */

export type LayoutId =
  | 'quad_x' | 'quad_plus' | 'quad_h' | 'tri_y' | 'hexa_x' | 'hexa_plus'
  | 'octo_x' | 'octo_plus' | 'y6' | 'x8' | 'vtol_quadplane' | 'fixed_wing' | 'heli'

export type LayoutKind = 'ring' | 'wing_ring' | 'wing' | 'heli'

export type Provenance =
  | 'VERIFIED_PRIMARY' | 'VERIFIED_SECONDARY' | 'IMAGE_PROPORTION_ESTIMATE'
  | 'SURROGATE_ASSUMPTION' | 'USER_SUPPLIED_UNVERIFIED' | 'DERIVED' | 'UNKNOWN' | 'BLOCKED_CONFLICT'

export interface Envelope { length: number; width: number; height: number }

export type BodyShape = 'capsule' | 'box' | 'pod' | 'tube' | 'wedge'
export type GearStyle = 'skids' | 'legs' | 'rails' | 'none'
export type TailStyle = 'conventional' | 't_tail' | 'v_tail' | 'none'
export type Mount = 'belly' | 'nose' | 'top' | 'tail' | 'left' | 'right'

/** Proportions as fractions of the envelope, so resizing keeps the look. */
export interface ShapeRatios {
  rotor: number        // prop diameter / min(L, W)
  bodyL: number        // / L
  bodyW: number        // / L
  bodyH: number        // / L
  armR: number         // arm root radius / min(L, W)
  motorR: number       // / min(L, W)
  motorH: number       // / min(L, W)
  bladeChord: number   // / min(L, W)
  gearH: number        // / L
  wingRoot: number     // / L
  wingTip: number      // / L
  wingSweep: number    // / L
  wingThick: number    // / L
  wingDihedral: number // / W
  tailScale: number    // unitless
}

export type FrameMaterial = 'polymer' | 'carbon' | 'aluminium' | 'ti_carbon'
export type Chemistry = 'lipo' | 'liion' | 'solid' | 'hydrogen'
export type AvionicsTier = 'hobby' | 'pro' | 'mil'
export type PropMaterial = 'plastic' | 'carbon'
export type Finish = 'matte' | 'satin' | 'gloss'
export type Pattern = 'solid' | 'split' | 'stripe' | 'digital' | 'hazard'

export interface Internals {
  frameMaterial: FrameMaterial
  motorId: string
  propBlades: number
  propMaterial: PropMaterial
  battery: { chemistry: Chemistry; cells: number; capacityMah: number; position: number } // -1 aft .. +1 fwd
  avionics: AvionicsTier
}

export interface LoadoutItem { id: string; mount: Mount }

export interface Livery {
  primary: string
  secondary: string
  accent: string
  finish: Finish
  pattern: Pattern
}

export interface EvidenceSource { id: string; org: string; title: string; tier: number; url: string; date: string }
export interface EvidenceClaim { field: string; value: number; src: string; status: Provenance; quote: string }
export interface Evidence {
  manufacturer: string
  model: string
  sources: EvidenceSource[]
  claims: EvidenceClaim[]
  approved: Partial<Record<'length' | 'width' | 'height' | 'rotor_diameter' | 'mass', { value: number; status: Provenance }>>
}

export interface DroneSpec {
  version: 3
  name: string
  origin: 'design' | 'replica' | 'import' | 'remix'
  layout: LayoutId
  /** L and W are always authoritative. H is a target only when `heightLocked`. */
  envelope: Envelope
  heightLocked: boolean
  ratios: ShapeRatios
  /** Published rotor diameter beats the ratio-derived surrogate. */
  rotorDiameterOverride?: number
  body: { shape: BodyShape; gear: GearStyle; tail: TailStyle; thrust: 'nose' | 'pusher'; gpsMast: boolean; antennas: number; gimbal: boolean }
  internals: Internals
  weapons: LoadoutItem[]
  systems: LoadoutItem[]
  livery: Livery
  evidence?: Evidence
  /** Published mass for replicas and imports: the model reports its own estimate beside it. */
  publishedMassKg?: number
  notes?: string
}

/** A drone as stored: the spec plus bookkeeping. */
export interface DroneRecord {
  id: string
  ownerId: string
  ownerName?: string
  spec: DroneSpec
  isPublic: boolean
  createdAt: string
  updatedAt: string
  likes?: number
  downloads?: number
  /** Cached derived numbers so lists do not need to rerun the physics. */
  summary?: DroneSummary
  thumbnail?: string
}

export interface DroneSummary {
  massKg: number
  priceUsd: number
  maxSpeed: number
  endurance: number
  powerScore: number
  rarity: Rarity
  className: string
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
