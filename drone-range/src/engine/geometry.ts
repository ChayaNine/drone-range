/**
 * Parametric drone geometry. Pure three.js BufferGeometry, no renderer: the same code builds
 * the designer preview, the simulator airframe, the LiDAR target and the exported files, in the
 * browser or in a Vercel function.
 *
 * Frame: X forward, Y left, Z up, metres. After assembly everything is translated so the
 * bounding box of the frozen-phase mesh is centred on the origin (the Gazebo convention used
 * since v1).
 *
 * Rotors are returned separately from static parts so the simulator can spin them. Exporters
 * merge both.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { DroneSpec, Mount, Provenance } from './types'
import { LAYOUTS, solveStations, type Station } from './layouts'
import { resolveShape, type Shape } from './shape'
import { batteryDims } from './battery'
import { layoutPoints } from './points'
export { batteryDims }

export type MatKey =
  | 'hull' | 'hull2' | 'frame' | 'motor' | 'bell' | 'prop' | 'dark' | 'glass' | 'metal'
  | 'accent' | 'weapon' | 'sensor' | 'navRed' | 'navGreen' | 'navWhite' | 'lamp' | 'battery'

export type PartKind = 'body' | 'arm' | 'motor' | 'gear' | 'module' | 'wing' | 'detail' | 'battery' | 'gimbal'

export interface Part {
  name: string
  geo: THREE.BufferGeometry
  mat: MatKey
  prov: Provenance
  kind: PartKind
  moduleId?: string
}

export interface RotorInfo {
  index: number
  tag: string
  center: THREE.Vector3
  /** Unit spin axis in model frame. */
  axis: THREE.Vector3
  dir: 1 | -1
  radius: number
  role: 'lift' | 'thrust' | 'main' | 'tail'
  /** Blades and hub in rotor-local frame: spin axis +Z, origin at hub centre. */
  blades: THREE.BufferGeometry
  hub: THREE.BufferGeometry
}

export interface ModulePlacement { id: string; kind: 'weapon' | 'system'; mount: Mount; center: THREE.Vector3; muzzle: THREE.Vector3 }

export interface DroneGeometry {
  shape: Shape
  parts: Part[]
  rotors: RotorInfo[]
  modules: ModulePlacement[]
  stations: Station[]
  hardpoints: Record<Mount, THREE.Vector3>
  /** Where the lift acts: rotor centroid (rotorcraft) or wing quarter-chord (aeroplanes). */
  thrustCenter: THREE.Vector3
  batteryCenter: THREE.Vector3
  bodyCenter: THREE.Vector3
  bbox: THREE.Box3
  size: THREE.Vector3
  /** Mean aerodynamic chord for aeroplanes (m), else 0. */
  mac: number
  wingArea: number
  feasible: boolean
  residual: number
  /** Translation applied to centre the model: pre-centring point + (-centre) = exported point. */
  centre: THREE.Vector3
}

const EST: Provenance = 'IMAGE_PROPORTION_ESTIMATE'
const ASM: Provenance = 'SURROGATE_ASSUMPTION'
const PI = Math.PI

// ───────────────────────────── geometry helpers ─────────────────────────────

/** Normalise attributes so every part can be merged with every other: non-indexed, normals, no uv. */
function fin(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name)
  out.morphAttributes = {}
  out.clearGroups()
  return out
}

/** Cylinder lying along +X (three's default axis is Y). */
function cylX(rTip: number, rRoot: number, len: number, seg = 16) {
  const g = new THREE.CylinderGeometry(rTip, rRoot, len, seg)
  g.rotateZ(-PI / 2) // +Y -> +X ; top (rTip) ends at +X
  return g
}
function cylZ(r: number, h: number, seg = 18, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg)
  g.rotateX(PI / 2) // +Y -> +Z
  return g
}
function cylY(r: number, h: number, seg = 16) { return new THREE.CylinderGeometry(r, r, h, seg) }
function box(x: number, y: number, z: number) { return new THREE.BoxGeometry(x, y, z) }
function rbox(x: number, y: number, z: number, rad?: number) {
  const r = rad ?? Math.min(x, y, z) * 0.18
  return new RoundedBoxGeometry(x, y, z, 3, Math.max(r, 1e-4))
}
function sphere(r: number, w = 20, h = 14) { return new THREE.SphereGeometry(r, w, h) }

/** Mirror across XZ and restore outward winding (negative scale flips it). */
function mirrorY(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone()
  m.scale(1, -1, 1)
  if (m.index) {
    const ix = Array.from(m.index.array)
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t }
    m.setIndex(ix)
  } else {
    const p = m.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i += 3) {
      const bx = p.getX(i + 1), by = p.getY(i + 1), bz = p.getZ(i + 1)
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2))
      p.setXYZ(i + 2, bx, by, bz)
    }
  }
  m.deleteAttribute('normal')
  m.computeVertexNormals()
  return m
}

/**
 * Closed wing panel with a symmetric aerofoil section, spanning +Y. `sweep` moves the tip aft,
 * `dihedral` lifts it. Root and tip are capped, so the panel is a closed solid.
 */
function wingPanel(span: number, cRoot: number, cTip: number, thick: number, sweep: number, dihedral: number, sections = 4) {
  const N = 18 // points around the section
  const tRatio = Math.min(Math.max(thick / Math.max(cRoot, 1e-6), 0.04), 0.22)
  const prof: [number, number][] = []
  for (let i = 0; i < N; i++) {
    // cosine spacing round the loop: upper surface LE->TE then lower TE->LE
    const a = (i / N) * 2 * PI
    const x = 0.5 * (1 + Math.cos(a)) // 1 at TE ... 0 at LE ... back
    const yt = 5 * tRatio * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    prof.push([x, a < PI ? yt : -yt])
  }
  const verts: number[] = []
  for (let s = 0; s <= sections; s++) {
    const f = s / sections
    const c = cRoot + (cTip - cRoot) * f
    const y = span * f
    const xLE = c / 2 - sweep * f // section centred on x=0 at the root
    const zOff = dihedral * f
    for (const [px, pz] of prof) verts.push(xLE - px * c, y, zOff + pz * c)
  }
  const idx: number[] = []
  for (let s = 0; s < sections; s++) {
    const a = s * N, b = (s + 1) * N
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N
      idx.push(a + k, b + k, b + k2, a + k, b + k2, a + k2)
    }
  }
  const cRootI = verts.length / 3
  verts.push(0, 0, 0)
  const cTipI = cRootI + 1
  verts.push(cTip / 2 - sweep - cTip / 2, span, dihedral)
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N
    idx.push(cRootI, k2, k)
    idx.push(cTipI, sections * N + k, sections * N + k2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  // Ensure outward winding: the signed volume must be positive.
  if (signedVolume(g) < 0) {
    const ix = g.index!.array as unknown as number[]
    const flipped: number[] = []
    for (let i = 0; i < ix.length; i += 3) flipped.push(ix[i], ix[i + 2], ix[i + 1])
    g.setIndex(flipped)
    g.computeVertexNormals()
  }
  return g
}

function signedVolume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position')
  const ix = g.index ? g.index.array : null
  const n = ix ? ix.length : p.count
  let v = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < n; i += 3) {
    const i0 = ix ? ix[i] : i, i1 = ix ? ix[i + 1] : i + 1, i2 = ix ? ix[i + 2] : i + 2
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2)
    v += a.dot(b.clone().cross(c)) / 6
  }
  return v
}

/** One propeller blade along +X with taper and twist (port of prop_blade in airframe.py). */
function blade(len: number, chord: number, thick: number, sections = 8) {
  const verts: number[] = []
  for (let s = 0; s < sections; s++) {
    const x = len * (0.12 + 0.88 * (s / (sections - 1)))
    const taper = Math.min(Math.max(1 - 0.55 * (x / len) ** 2, 0.25), 1)
    const tw = ((14 - 10 * (s / (sections - 1))) * PI) / 180
    const c = chord * taper, th = thick * taper
    const pts = [[c / 2, th / 2], [-c / 2, th / 2], [-c / 2, -th / 2], [c / 2, -th / 2]]
    for (const [yy, zz] of pts) {
      verts.push(x, yy * Math.cos(tw) - zz * Math.sin(tw), yy * Math.sin(tw) + zz * Math.cos(tw))
    }
  }
  const idx: number[] = []
  for (let i = 0; i < sections - 1; i++) {
    const a = 4 * i, b = 4 * (i + 1)
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      idx.push(a + k, b + k, b + k2, a + k, b + k2, a + k2)
    }
  }
  const n = verts.length / 3
  const avg = (o: number) => {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) { x += verts[(o + k) * 3]; y += verts[(o + k) * 3 + 1]; z += verts[(o + k) * 3 + 2] }
    return [x / 4, y / 4, z / 4]
  }
  verts.push(...avg(0), ...avg(4 * (sections - 1)))
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4
    idx.push(n, k2, k)
    idx.push(n + 1, 4 * (sections - 1) + k, 4 * (sections - 1) + k2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function rotorBlades(radius: number, count: number, chord: number, thick: number, phase = 0) {
  const parts: THREE.BufferGeometry[] = []
  for (let b = 0; b < count; b++) {
    const g = blade(radius, chord, thick)
    g.rotateZ((2 * PI * b) / count + phase)
    parts.push(fin(g))
  }
  return mergeGeometries(parts)!
}

// ───────────────────────────── body shapes ─────────────────────────────

function bodyGeometry(shape: string, l: number, w: number, h: number): THREE.BufferGeometry[] {
  switch (shape) {
    case 'box':
      return [rbox(l, w, h)]
    case 'pod': {
      const s = sphere(0.5, 28, 18)
      s.scale(l, w, h)
      return [s]
    }
    case 'tube': {
      // Lathe a fuselage profile: rounded nose, constant section, tapering tail.
      const pts: THREE.Vector2[] = []
      const N = 22
      for (let i = 0; i <= N; i++) {
        const t = i / N
        let r: number
        if (t < 0.22) r = Math.sqrt(1 - ((0.22 - t) / 0.22) ** 2)
        else if (t < 0.62) r = 1
        else r = 1 - 0.62 * ((t - 0.62) / 0.38) ** 1.4
        pts.push(new THREE.Vector2(Math.max(r, 0) * (w / 2), (0.5 - t) * l))
      }
      pts[0].x = 0
      pts[N].x = Math.max(pts[N].x, 0)
      // close the tail
      pts.push(new THREE.Vector2(0, -0.5 * l))
      pts.reverse()
      const g = new THREE.LatheGeometry(pts, 24)
      g.rotateZ(-PI / 2) // lathe axis Y -> X, nose at +X
      g.scale(1, 1, h / w)
      return [g]
    }
    case 'wedge': {
      const s = new THREE.Shape()
      s.moveTo(l / 2, 0)
      s.lineTo(l * 0.05, w / 2)
      s.lineTo(-l / 2, w * 0.36)
      s.lineTo(-l * 0.42, 0)
      s.lineTo(-l / 2, -w * 0.36)
      s.lineTo(l * 0.05, -w / 2)
      s.closePath()
      const g = new THREE.ExtrudeGeometry(s, {
        depth: h * 0.6, bevelEnabled: true, bevelThickness: h * 0.2, bevelSize: Math.min(w, l) * 0.06, bevelSegments: 2, steps: 1,
      })
      g.translate(0, 0, -h * 0.3)
      return [g]
    }
    case 'capsule':
    default: {
      const g = new THREE.CapsuleGeometry(w / 2, Math.max(l - w, 1e-4), 10, 24)
      g.rotateZ(-PI / 2)
      g.scale(1, 1, h / w)
      return [g]
    }
  }
}

// ───────────────────────────── loadout module meshes ─────────────────────────────
// Each builder returns parts relative to its attachment point. Hanging modules extend toward
// -Z from z=0; top modules extend toward +Z. Barrels and apertures point +X.

type Piece = { g: THREE.BufferGeometry; mat: MatKey }

function moduleMesh(id: string, up: boolean, ref: number): { pieces: Piece[]; height: number; muzzle: THREE.Vector3 } {
  const P: Piece[] = []
  const s = (z: number) => (up ? z : -z)
  const muzzle = new THREE.Vector3()
  let height = 0.05
  const add = (g: THREE.BufferGeometry, mat: MatKey) => P.push({ g, mat })
  switch (id) {
    case 'kinetic': {
      const base = cylZ(0.055, 0.03, 20); base.translate(0, 0, s(0.015)); add(base, 'weapon')
      const dome = sphere(0.062, 22, 14); dome.scale(1, 1, 0.8); dome.translate(0, 0, s(0.06)); add(dome, 'weapon')
      const barrel = cylX(0.011, 0.014, 0.26, 12); barrel.translate(0.15, 0, s(0.06)); add(barrel, 'metal')
      const shroud = cylX(0.02, 0.02, 0.06, 12); shroud.translate(0.06, 0, s(0.06)); add(shroud, 'dark')
      const ammo = rbox(0.11, 0.07, 0.05); ammo.translate(-0.07, 0.05, s(0.04)); add(ammo, 'dark')
      muzzle.set(0.28, 0, s(0.06)); height = 0.11
      break
    }
    case 'bomb': {
      const pylon = rbox(0.30, 0.05, 0.03); pylon.translate(0, 0, s(0.015)); add(pylon, 'weapon')
      for (const [dx, dy] of [[0.07, 0.05], [0.07, -0.05], [-0.09, 0.05], [-0.09, -0.05]]) {
        const b = new THREE.CapsuleGeometry(0.032, 0.11, 6, 14); b.rotateZ(-PI / 2); b.translate(dx, dy, s(0.07)); add(b, 'dark')
        const finG = box(0.035, 0.07, 0.004); finG.translate(dx - 0.075, dy, s(0.07)); add(finG, 'metal')
      }
      muzzle.set(0, 0, s(0.11)); height = 0.11
      break
    }
    case 'net': {
      const plate = rbox(0.16, 0.12, 0.025); plate.translate(0, 0, s(0.012)); add(plate, 'weapon')
      for (const [dy, dz] of [[0.032, 0.035], [-0.032, 0.035], [0.032, 0.085], [-0.032, 0.085]]) {
        const t = cylX(0.024, 0.024, 0.2, 14); t.rotateZ(dy > 0 ? 0.06 : -0.06); t.translate(0.05, dy, s(dz)); add(t, 'dark')
        const cap = cylX(0.021, 0.021, 0.005, 14); cap.translate(0.152, dy, s(dz)); add(cap, 'accent')
      }
      muzzle.set(0.16, 0, s(0.06)); height = 0.11
      break
    }
    case 'missile': {
      const pod = rbox(0.32, 0.10, 0.075); pod.translate(0, 0, s(0.05)); add(pod, 'weapon')
      for (const dy of [0.024, -0.024]) {
        const tube = cylX(0.02, 0.02, 0.012, 14); tube.translate(0.163, dy, s(0.05)); add(tube, 'dark')
        const nose = new THREE.ConeGeometry(0.018, 0.04, 14); nose.rotateZ(-PI / 2); nose.translate(0.182, dy, s(0.05)); add(nose, 'accent')
      }
      const rail = box(0.24, 0.02, 0.015); rail.translate(0, 0, s(0.007)); add(rail, 'metal')
      muzzle.set(0.2, 0, s(0.05)); height = 0.09
      break
    }
    case 'laser': {
      const yoke = box(0.03, 0.07, 0.03); yoke.translate(0, 0, s(0.015)); add(yoke, 'weapon')
      const ball = sphere(0.042); ball.translate(0, 0, s(0.06)); add(ball, 'weapon')
      const ap = cylX(0.016, 0.016, 0.03, 16); ap.translate(0.042, 0, s(0.06)); add(ap, 'glass')
      muzzle.set(0.06, 0, s(0.06)); height = 0.1
      break
    }
    case 'emp': {
      const base = cylZ(0.05, 0.03, 20); base.translate(0, 0, s(0.015)); add(base, 'weapon')
      const coil = new THREE.TorusGeometry(0.1, 0.017, 10, 36); coil.translate(0, 0, s(0.06)); add(coil, 'accent')
      const core = cylZ(0.034, 0.09, 18); core.translate(0, 0, s(0.06)); add(core, 'metal')
      const tip = sphere(0.03); tip.translate(0, 0, s(0.11)); add(tip, 'lamp')
      muzzle.set(0, 0, s(0.08)); height = 0.14
      break
    }
    case 'radar': {
      if (up) {
        const base = cylZ(0.07, 0.025, 24); base.translate(0, 0, 0.012); add(base, 'dark')
        const dome = new THREE.SphereGeometry(0.095, 28, 14, 0, 2 * PI, 0, PI / 2); dome.rotateX(PI / 2); dome.scale(1, 1, 0.55); dome.translate(0, 0, 0.025)
        add(dome, 'sensor'); height = 0.08
      } else {
        const panel = rbox(0.03, 0.2, 0.13, 0.008); panel.translate(0.04, 0, s(0.08)); add(panel, 'sensor')
        const arm = box(0.04, 0.03, 0.02); arm.translate(0.01, 0, s(0.01)); add(arm, 'dark'); height = 0.15
      }
      muzzle.set(0.05, 0, s(0.05))
      break
    }
    case 'lidar': {
      // Livox Avia published envelope: 91 x 61.2 x 64.8 mm.
      const body = rbox(0.0612, 0.091, 0.0648, 0.006); body.translate(0, 0, s(0.0324 + 0.012)); add(body, 'sensor')
      const win = cylX(0.024, 0.024, 0.006, 24); win.translate(0.033, 0, s(0.0324 + 0.012)); add(win, 'glass')
      const brk = box(0.03, 0.05, 0.012); brk.translate(0, 0, s(0.006)); add(brk, 'dark')
      muzzle.set(0.036, 0, s(0.044)); height = 0.077
      break
    }
    case 'thermal': {
      const yoke = box(0.03, 0.08, 0.03); yoke.translate(0, 0, s(0.015)); add(yoke, 'dark')
      const ball = sphere(0.058); ball.translate(0, 0, s(0.075)); add(ball, 'sensor')
      const lens = cylX(0.026, 0.026, 0.02, 18); lens.translate(0.058, 0.012, s(0.075)); add(lens, 'glass')
      const lens2 = cylX(0.012, 0.012, 0.016, 14); lens2.translate(0.056, -0.026, s(0.075)); add(lens2, 'glass')
      muzzle.set(0.07, 0, s(0.075)); height = 0.135
      break
    }
    case 'carrier': {
      const bay = rbox(0.44, 0.3, 0.11, 0.02); bay.translate(0, 0, s(0.055)); add(bay, 'weapon')
      for (const dx of [-0.13, 0, 0.13]) {
        const door = box(0.12, 0.24, 0.004); door.translate(dx, 0, s(0.112)); add(door, 'accent')
      }
      muzzle.set(0, 0, s(0.12)); height = 0.115
      break
    }
    case 'searchlight': {
      const yoke = box(0.03, 0.1, 0.03); yoke.translate(0, 0, s(0.015)); add(yoke, 'dark')
      const can = cylX(0.05, 0.042, 0.1, 22); can.translate(0, 0, s(0.07)); add(can, 'weapon')
      const lens = cylX(0.046, 0.046, 0.006, 22); lens.translate(0.052, 0, s(0.07)); add(lens, 'lamp')
      muzzle.set(0.06, 0, s(0.07)); height = 0.12
      break
    }
    case 'smoke': {
      const rack = box(0.1, 0.12, 0.02); rack.translate(0, 0, s(0.01)); add(rack, 'dark')
      for (let i = 0; i < 6; i++) {
        const c = cylX(0.017, 0.017, 0.11, 12)
        c.translate(-0.02, -0.045 + (i % 3) * 0.045, s(0.035 + Math.floor(i / 3) * 0.038)); add(c, i % 2 ? 'metal' : 'accent')
      }
      muzzle.set(-0.08, 0, s(0.05)); height = 0.09
      break
    }
    case 'winch': {
      const frame = box(0.12, 0.1, 0.03); frame.translate(0, 0, s(0.015)); add(frame, 'dark')
      const spool = cylY(0.04, 0.085, 18); spool.translate(0, 0, s(0.06)); add(spool, 'weapon')
      const cable = cylZ(0.002, 0.08, 6); cable.translate(0, 0, s(0.14)); add(cable, 'metal')
      const hook = new THREE.TorusGeometry(0.02, 0.005, 6, 16, PI * 1.5); hook.rotateX(PI / 2); hook.translate(0, 0, s(0.19)); add(hook, 'accent')
      muzzle.set(0, 0, s(0.2)); height = 0.21
      break
    }
    case 'parachute': {
      const can = cylZ(0.06, 0.11, 22); can.translate(0, 0, s(0.055)); add(can, 'weapon')
      const cap = cylZ(0.063, 0.02, 22); cap.translate(0, 0, s(0.115)); add(cap, 'accent')
      muzzle.set(0, 0, s(0.12)); height = 0.125
      break
    }
    default:
      break
  }
  void ref
  return { pieces: P, height, muzzle }
}

// ───────────────────────────── assembly ─────────────────────────────

export function buildGeometry(spec: DroneSpec, shapeOverride?: Partial<Shape>): DroneGeometry {
  const S = resolveShape(spec, shapeOverride)
  const lay = LAYOUTS[spec.layout]
  const parts: Part[] = []
  const rotors: RotorInfo[] = []
  const add = (name: string, g: THREE.BufferGeometry, mat: MatKey, prov: Provenance, kind: PartKind, moduleId?: string) =>
    parts.push({ name, geo: fin(g), mat, prov, kind, moduleId })

  const { L, W } = S
  let bl = S.bodyL, bw = S.bodyW, bh = S.bodyH
  let mac = 0, wingArea = 0
  const thrustCenter = new THREE.Vector3()
  let bodyCenter = new THREE.Vector3()
  let stations: Station[] = []
  let feasible = true, residual = 0

  const usesNose = [...spec.weapons, ...spec.systems].some(m => m.mount === 'nose')

  // ── heli has its own assembly ──
  if (lay.kind === 'heli') {
    const rr = W / 2
    const mastX = L / 2 - rr
    const cabX = mastX + bl * 0.06
    bodyCenter = new THREE.Vector3(cabX, 0, 0)
    bodyGeometry(spec.body.shape === 'capsule' ? 'pod' : spec.body.shape, bl, bw, bh).forEach((g, i) => {
      g.translate(cabX, 0, 0); add(i ? `cabin_${i}` : 'cabin', g, 'hull', EST, 'body')
    })
    const canopy = sphere(0.5, 22, 14); canopy.scale(bl * 0.34, bw * 0.78, bh * 0.5); canopy.translate(cabX + bl * 0.2, 0, bh * 0.12)
    add('canopy', canopy, 'glass', EST, 'detail')
    const tailR = rr * 0.18
    const tx = -L / 2 + tailR
    const boomStart = cabX - bl * 0.42
    const boomLen = boomStart - tx
    if (boomLen > 1e-4) {
      const boom = cylX(bw * 0.2, bw * 0.1, boomLen, 14) // thick end (+X) meets the cabin
      boom.translate(boomStart - boomLen / 2, 0, bh * 0.1)
      add('tail_boom', boom, 'hull2', EST, 'arm')
    }
    const mast = cylZ(bw * 0.1, bh * 0.7, 14); mast.translate(mastX, 0, bh * 0.55); add('main_mast', mast, 'metal', ASM, 'detail')
    const hub = cylZ(bw * 0.22, S.hubH * 1.4, 18)
    rotors.push({
      index: 0, tag: 'main', center: new THREE.Vector3(mastX, 0, bh * 0.95), axis: new THREE.Vector3(0, 0, 1), dir: 1,
      radius: rr, role: 'main', blades: rotorBlades(rr, Math.max(S.bladeCount, 2), S.bladeChord * 1.6, S.bladeThick), hub: fin(hub),
    })
    thrustCenter.set(mastX, 0, bh * 0.95)
    const finG = wingPanel(bh * 1.3, bl * 0.16, bl * 0.1, bw * 0.08, bl * 0.06, 0)
    finG.rotateX(PI / 2); finG.translate(tx + tailR * 0.4, 0, bh * 0.3)
    add('tail_fin', finG, 'hull2', EST, 'wing')
    const thub = cylZ(bw * 0.06, bw * 0.04, 10)
    rotors.push({
      index: 1, tag: 'tail', center: new THREE.Vector3(tx, bw * 0.16, bh * 0.55), axis: new THREE.Vector3(0, 1, 0), dir: 1,
      radius: tailR, role: 'tail', blades: rotorBlades(tailR, 2, S.bladeChord * 0.7, S.bladeThick), hub: fin(thub),
    })
    addGear(spec, S, bl, bw, bh, cabX, add)
    if (spec.body.gimbal && !usesNose) addGimbal(S, bl, bh, cabX, add)
  } else {
    // ── rotorcraft rings, quadplanes and aeroplanes share the body ──
    bodyGeometry(spec.body.shape, bl, bw, bh).forEach((g, i) => add(i ? `body_${i}` : 'body', g, 'hull', EST, 'body'))
    bodyCenter = new THREE.Vector3(0, 0, 0)

    if (lay.kind === 'wing' || lay.kind === 'wing_ring') {
      const w = addWing(spec, S, bl, bh, add)
      mac = w.mac; wingArea = w.area
      thrustCenter.set(w.qcX, 0, bh * 0.1)
      const canopy = sphere(0.5, 20, 12); canopy.scale(bl * 0.22, bw * 0.62, bh * 0.55); canopy.translate(bl * 0.26, 0, bh * 0.32)
      add('canopy', canopy, 'glass', EST, 'detail')
    }

    if (lay.kind === 'wing') {
      const pr = S.propD / 2
      const px = spec.body.thrust === 'nose' ? bl * 0.5 + 0.012 : -bl * 0.5 - 0.012
      const spin = sphere(Math.max(S.motorR * 0.9, 0.012), 16, 10); spin.scale(1.5, 1, 1); spin.translate(px, 0, 0)
      add('spinner', spin, 'accent', ASM, 'detail')
      const hub = cylZ(Math.max(S.motorR * 0.5, 0.008), 0.012, 12)
      rotors.push({
        index: 0, tag: spec.body.thrust, center: new THREE.Vector3(px + (spec.body.thrust === 'nose' ? 0.014 : -0.014), 0, 0),
        axis: new THREE.Vector3(1, 0, 0), dir: 1, radius: pr, role: 'thrust',
        blades: rotorBlades(pr, S.bladeCount, S.bladeChord, S.bladeThick), hub: fin(hub),
      })
    } else {
      const sol = solveStations(spec.layout, L, W, S.propD)
      stations = sol.stations
      feasible = sol.feasible; residual = sol.residual
      const zb = bh * 0.06
      const boom = lay.ringFrom === 'boom'
      if (boom) addBooms(sol.stations, S, bw, zb, add)
      let sx = 0, sy = 0
      for (const st of sol.stations) {
        sx += st.x; sy += st.y
        const yaw = Math.atan2(st.y, st.x)
        const armLen = Math.hypot(st.x, st.y) - bw * 0.34
        if (!boom && armLen > 1e-4) {
          const arm = cylX(S.armTip, S.armRoot, armLen, 14)
          arm.translate(armLen / 2, 0, 0); arm.rotateZ(yaw)
          arm.translate(Math.cos(yaw) * bw * 0.3, Math.sin(yaw) * bw * 0.3, zb)
          add(`arm_${st.tag}`, arm, 'frame', EST, 'arm')
        }
        const levels: [number, string][] = lay.coax === 2 ? [[1, '_upper'], [-1, '_lower']] : [[1, '']]
        for (const [sg, sfx] of levels) {
          const pod = cylZ(S.motorR, S.motorH * 0.62, 18); pod.translate(st.x, st.y, zb + sg * S.motorH * 0.12)
          add(`motor_${st.tag}${sfx}`, pod, 'motor', ASM, 'motor')
          const bell = cylZ(S.motorR * 0.94, S.motorH * 0.42, 18, S.motorR * 0.8)
          bell.translate(st.x, st.y, zb + sg * S.motorH * 0.58)
          add(`bell_${st.tag}${sfx}`, bell, 'bell', ASM, 'motor')
          const zp = zb + sg * (S.motorH * 0.8 + S.hubH)
          const hub = cylZ(S.motorR * 0.55, S.hubH, 14)
          // Adjacent rotors counter-rotate; coaxial pairs counter-rotate.
          const dir = (((st.index % 2 === 0) ? 1 : -1) * (sg > 0 ? 1 : -1)) as 1 | -1
          rotors.push({
            index: rotors.length, tag: st.tag + sfx, center: new THREE.Vector3(st.x, st.y, zp), axis: new THREE.Vector3(0, 0, 1), dir,
            radius: S.propD / 2, role: 'lift',
            blades: rotorBlades(S.propD / 2, S.bladeCount, S.bladeChord, S.bladeThick, sg > 0 ? 0 : PI / 5),
            hub: fin(hub),
          })
        }
        // navigation lights: red left (+Y), green right, white aft
        const nav = sphere(Math.max(0.0035, S.motorR * 0.22), 10, 8)
        nav.translate(st.x + Math.cos(yaw) * S.motorR * 1.05, st.y + Math.sin(yaw) * S.motorR * 1.05, zb)
        add(`nav_${st.tag}`, nav, st.y > 1e-6 ? 'navRed' : st.y < -1e-6 ? 'navGreen' : 'navWhite', ASM, 'detail')
      }
      if (sol.stations.length) thrustCenter.set(sx / sol.stations.length, sy / sol.stations.length, zb)
    }

    if (lay.kind !== 'wing') addExtras(spec, S, bl, bw, bh, add)
    else if (spec.body.gpsMast || spec.body.antennas) addExtras({ ...spec, internals: { ...spec.internals } }, S, bl, bw, bh, add, true)
    if (spec.body.gimbal && !usesNose) addGimbal(S, bl, bh, 0, add)
    addGear(spec, S, bl, bw, bh, 0, add)
  }

  // ── hardpoints (before centring): shared with the performance model ──
  const wingish = lay.kind === 'wing' || lay.kind === 'wing_ring'
  const hardpoints = layoutPoints(spec, shapeOverride).hardpoints

  // ── loadout modules ──
  const modules = placeModules(spec, hardpoints, wingish, bw, add)

  // ── centre on the bounding box of the frozen-phase mesh ──
  const bbox = new THREE.Box3()
  const tmp = new THREE.Box3()
  for (const p of parts) { p.geo.computeBoundingBox(); bbox.union(p.geo.boundingBox!) }
  const q = new THREE.Quaternion()
  for (const r of rotors) {
    const g = r.blades.clone()
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.axis)
    g.applyQuaternion(q); g.translate(r.center.x, r.center.y, r.center.z)
    g.computeBoundingBox(); tmp.copy(g.boundingBox!); bbox.union(tmp)
  }
  const centre = bbox.getCenter(new THREE.Vector3())
  for (const p of parts) p.geo.translate(-centre.x, -centre.y, -centre.z)
  for (const r of rotors) r.center.sub(centre)
  for (const k of Object.keys(hardpoints) as Mount[]) hardpoints[k].sub(centre)
  for (const m of modules) { m.center.sub(centre); m.muzzle.sub(centre) }
  thrustCenter.sub(centre)
  bodyCenter.sub(centre)
  const batteryCenter = batteryPosition(spec, S, bl, bh).sub(centre)
  for (const st of stations) { st.x -= centre.x; st.y -= centre.y }
  bbox.translate(centre.clone().negate())

  return {
    shape: S, parts, rotors, modules, stations, hardpoints, thrustCenter, batteryCenter, bodyCenter,
    bbox, size: bbox.getSize(new THREE.Vector3()), mac, wingArea, feasible, residual, centre,
  }
}

function placeModules(spec: DroneSpec, hardpoints: Record<Mount, THREE.Vector3>, wingish: boolean, bw: number,
  add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind, id?: string) => void): ModulePlacement[] {
  const modules: ModulePlacement[] = []
  const all: { id: string; mount: Mount; kind: 'weapon' | 'system' }[] = [
    ...spec.weapons.map(w => ({ ...w, kind: 'weapon' as const })),
    ...spec.systems.map(w => ({ ...w, kind: 'system' as const })),
  ]
  for (const m of all) {
    if (m.id === 'stealth') continue
    const up = m.mount === 'top'
    const mesh = moduleMesh(m.id, up, 0)
    const hp = hardpoints[m.mount]
    for (const pc of mesh.pieces) {
      const g = pc.g
      if (m.mount === 'tail') g.rotateZ(PI) // tail modules face aft
      g.translate(hp.x, hp.y, hp.z)
      add(`${m.kind}_${m.id}_${m.mount}`, g, pc.mat, ASM, 'module', m.id)
    }
    const mz = mesh.muzzle.clone()
    if (m.mount === 'tail') mz.applyAxisAngle(new THREE.Vector3(0, 0, 1), PI)
    const pylon = m.mount === 'left' || m.mount === 'right'
    if (pylon && !wingish && bw > 0) {
      const strut = box(0.03, Math.abs(hp.y) - bw / 2 + 0.01, 0.012)
      strut.translate(hp.x, hp.y / 2 + Math.sign(hp.y) * bw / 4, hp.z + 0.004)
      add(`pylon_${m.mount}`, strut, 'frame', ASM, 'module', m.id)
    }
    modules.push({
      id: m.id, kind: m.kind, mount: m.mount,
      center: hp.clone().add(new THREE.Vector3(0, 0, up ? mesh.height / 2 : -mesh.height / 2)),
      muzzle: hp.clone().add(mz),
    })
  }
  return modules
}

/** Position + normal only, so geometries from any source can be merged together. */
export function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('color') && !g.getAttribute('uv') && !g.index) return g
  const c = g.index ? g.toNonIndexed() : g.clone()
  for (const n of Object.keys(c.attributes)) if (n !== 'position' && n !== 'normal') c.deleteAttribute(n)
  return c
}

function addWing(spec: DroneSpec, S: Shape, bl: number, bh: number, add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind) => void) {
  const half = S.W / 2
  const cr = S.wingRoot, ct = S.wingTip, th = S.wingThick
  const x0 = bl * 0.02, z0 = bh * 0.1
  const left = wingPanel(half, cr, ct, th, S.wingSweep, S.wingDihedral)
  const right = mirrorY(left)
  left.translate(x0, 0, z0); right.translate(x0, 0, z0)
  add('wing_left', left, 'hull', EST, 'wing'); add('wing_right', right, 'hull', EST, 'wing')
  // Wing-tip accents read the span at a glance.
  for (const sy of [1, -1]) {
    const tip = box(ct * 0.5, 0.004, th * 0.8)
    tip.translate(x0 - S.wingSweep - ct * 0.1, sy * half, z0 + S.wingDihedral)
    add(`wingtip_${sy > 0 ? 'left' : 'right'}`, tip, 'accent', ASM, 'detail')
    const nav = sphere(Math.max(0.004, th * 0.35), 10, 8)
    nav.translate(x0 - S.wingSweep + ct * 0.3, sy * half, z0 + S.wingDihedral)
    add(`nav_wing_${sy > 0 ? 'left' : 'right'}`, nav, sy > 0 ? 'navRed' : 'navGreen', ASM, 'detail')
  }
  const tail = spec.body.tail
  const ts = S.tailScale
  const tx = -bl * 0.44
  if (tail === 'conventional' || tail === 't_tail') {
    const zh = bh * 0.1 + (tail === 't_tail' ? bh * 1.5 * ts : 0)
    const hp = wingPanel((S.W * 0.3 * ts) / 2, cr * 0.55, cr * 0.38, th * 0.7, cr * 0.16, 0)
    const hpR = mirrorY(hp)
    hp.translate(tx, 0, zh); hpR.translate(tx, 0, zh)
    add('tailplane_left', hp, 'hull', EST, 'wing'); add('tailplane_right', hpR, 'hull', EST, 'wing')
    const fin = wingPanel(bh * 1.7 * ts, cr * 0.62, cr * 0.34, th * 0.7, cr * 0.34, 0)
    fin.rotateX(PI / 2); fin.translate(tx, 0, bh * 0.18)
    add('fin', fin, 'hull2', EST, 'wing')
  } else if (tail === 'v_tail') {
    // Both panels rotate UP by 37 degrees; the right one is then mirrored. (The v2 builder
    // rotated the right panel down before mirroring, which pointed it at the ground.)
    const vp = wingPanel(S.W * 0.19 * ts, cr * 0.58, cr * 0.34, th * 0.7, cr * 0.26, 0)
    vp.rotateX((37 * PI) / 180)
    const vpR = mirrorY(vp)
    vp.translate(tx, 0, bh * 0.22); vpR.translate(tx, 0, bh * 0.22)
    add('vtail_left', vp, 'hull2', EST, 'wing'); add('vtail_right', vpR, 'hull2', EST, 'wing')
  }
  const mac = (2 / 3) * cr * ((1 + ct / cr + (ct / cr) ** 2) / (1 + ct / cr))
  const area = S.W * (cr + ct) / 2
  // The MAC section sits at y = (b/6)(1+2λ)/(1+λ) on each panel; for linear taper its chord IS the MAC.
  const lam = ct / cr
  const f = ((1 + 2 * lam) / (1 + lam)) / 3
  const le = x0 + (cr + (ct - cr) * f) / 2 - S.wingSweep * f
  const qcX = le - mac / 4
  return { mac, area, qcX }
}

function addBooms(stations: Station[], S: Shape, bw: number, zb: number, add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind) => void) {
  const sides = new Map<string, Station[]>()
  for (const st of stations) {
    const k = st.y.toFixed(6)
    sides.set(k, [...(sides.get(k) ?? []), st])
  }
  for (const [k, sts] of sides) {
    const sy = Number(k)
    const xs = sts.map(s => s.x)
    const x0 = Math.min(...xs), x1 = Math.max(...xs)
    const span = (x1 - x0) * 1.22
    if (span > 1e-4) {
      const b = cylX(S.armRoot * 0.92, S.armRoot, span, 12)
      b.translate(x0 - span * 0.09 + span / 2, sy, zb)
      add(`boom_${sy > 0 ? 'left' : 'right'}`, b, 'frame', EST, 'arm')
    }
  }
  void bw
}

function addGimbal(S: Shape, bl: number, bh: number, cx: number, add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind) => void) {
  const gw = S.gimbalW, gh = S.gimbalH
  const gx = cx + bl * 0.42
  const yoke = box(gw * 0.55, gw * 1.25, gh * 0.45); yoke.translate(gx, 0, -bh * 0.42)
  add('gimbal_yoke', yoke, 'dark', EST, 'gimbal')
  const head = rbox(gw, gw * 0.95, gh); head.translate(gx + gw * 0.12, 0, -bh * 0.42 - gh * 0.62)
  add('camera_head', head, 'sensor', EST, 'gimbal')
  for (const [i, o] of [[0, 1], [1, -1]] as const) {
    const lens = cylX(gw * 0.21, gw * 0.21, gw * 0.3, 18)
    lens.translate(gx + gw * 0.62, o * gw * 0.24, -bh * 0.42 - gh * 0.62)
    add(`sensor_aperture_${i}`, lens, 'glass', EST, 'gimbal')
  }
}

function addGear(spec: DroneSpec, S: Shape, bl: number, bw: number, bh: number, cx: number, add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind) => void) {
  const style = spec.body.gear
  if (style === 'none') return
  const h = Math.max(S.gearH, 0.004)
  if (style === 'skids') {
    for (const sy of [1, -1]) {
      const sk = rbox(bl * 0.3, bw * 0.1, Math.max(bh * 0.16, 0.003)); sk.translate(cx - bl * 0.22, sy * bw * 0.3, -bh * 0.44)
      add(`skid_${sy > 0 ? 'left' : 'right'}`, sk, 'dark', ASM, 'gear')
    }
  } else if (style === 'legs') {
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      const leg = cylZ(bw * 0.045, h, 10); leg.translate(cx + sx * bl * 0.24, sy * bw * 0.34, -bh * 0.4 - h / 2)
      add(`leg_${sx > 0 ? 'f' : 'r'}${sy > 0 ? 'l' : 'r'}`, leg, 'frame', ASM, 'gear')
      const foot = sphere(bw * 0.06, 10, 8); foot.translate(cx + sx * bl * 0.24, sy * bw * 0.34, -bh * 0.4 - h)
      add(`foot_${sx > 0 ? 'f' : 'r'}${sy > 0 ? 'l' : 'r'}`, foot, 'dark', ASM, 'gear')
    }
  } else if (style === 'rails') {
    for (const sy of [1, -1]) {
      for (const sx of [1, -1]) {
        const st = cylZ(bw * 0.04, h, 10); st.translate(cx + sx * bl * 0.2, sy * bw * 0.32, -bh * 0.4 - h / 2)
        add(`strut_${sx > 0 ? 'f' : 'r'}${sy > 0 ? 'l' : 'r'}`, st, 'frame', ASM, 'gear')
      }
      const rail = cylX(bw * 0.045, bw * 0.045, bl * 0.66, 10); rail.translate(cx, sy * bw * 0.32, -bh * 0.4 - h)
      add(`rail_${sy > 0 ? 'left' : 'right'}`, rail, 'dark', ASM, 'gear')
    }
  }
}

function batteryPosition(spec: DroneSpec, S: Shape, bl: number, bh: number): THREE.Vector3 {
  const d = batteryDims(spec)
  const kind = LAYOUTS[spec.layout].kind
  const x = spec.internals.battery.position * bl * 0.32
  if (kind === 'wing') return new THREE.Vector3(x + bl * 0.05, 0, 0)
  const cx = kind === 'heli' ? S.L / 2 - S.W / 2 + bl * 0.06 : 0
  return new THREE.Vector3(cx + x, 0, bh / 2 + d.z / 2)
}

function addExtras(spec: DroneSpec, S: Shape, bl: number, bw: number, bh: number, add: (n: string, g: THREE.BufferGeometry, m: MatKey, p: Provenance, k: PartKind) => void, skipBattery = false) {
  if (!skipBattery) {
    const d = batteryDims(spec)
    const pos = batteryPosition(spec, S, bl, bh)
    const bat = rbox(d.x, d.y, d.z, Math.min(d.y, d.z) * 0.15); bat.translate(pos.x, pos.y, pos.z)
    add('battery_pack', bat, 'battery', ASM, 'battery')
    const stripe = box(d.x * 0.18, d.y * 1.01, d.z * 1.01); stripe.translate(pos.x + d.x * 0.3, pos.y, pos.z)
    add('battery_label', stripe, 'accent', ASM, 'detail')
  }
  if (spec.body.gpsMast) {
    const stalk = cylZ(bw * 0.035, bh * 0.55, 10); stalk.translate(-bl * 0.3, 0, bh * 0.62)
    add('gps_mast', stalk, 'dark', ASM, 'detail')
    const puck = cylZ(bw * 0.16, bh * 0.12, 18); puck.translate(-bl * 0.3, 0, bh * 0.62 + bh * 0.32)
    add('gps_puck', puck, 'hull2', ASM, 'detail')
  }
  for (let i = 0; i < (spec.body.antennas | 0); i++) {
    const sy = i % 2 === 0 ? 1 : -1
    const rod = cylZ(bw * 0.018, bh * 1.5, 8)
    rod.rotateX(((24 * PI) / 180) * sy)
    rod.translate(-bl * 0.4, sy * bw * 0.26, -bh * 0.3)
    add(`antenna_${i}`, rod, 'dark', ASM, 'detail')
  }
  void S
}

// ───────────────────────────── merging for export ─────────────────────────────

export interface MergeOptions { includeRotors?: boolean; collision?: boolean }

/** One mesh of everything (Z-up, metres). `collision` drops blades, lenses, antennas and lights. */
export function mergeDrone(g: DroneGeometry, opt: MergeOptions = {}): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = []
  const skip = /^(sensor_aperture|antenna_|nav_|canopy|battery_label|wingtip_)/
  for (const p of g.parts) {
    if (opt.collision && (skip.test(p.name) || p.mat === 'glass')) continue
    list.push(plain(p.geo))
  }
  if (opt.includeRotors !== false) {
    const q = new THREE.Quaternion()
    for (const r of g.rotors) {
      const hub = r.hub.clone()
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.axis)
      hub.applyQuaternion(q); hub.translate(r.center.x, r.center.y, r.center.z)
      list.push(fin(hub))
      if (opt.collision) continue
      const bl = r.blades.clone()
      bl.applyQuaternion(q); bl.translate(r.center.x, r.center.y, r.center.z)
      list.push(fin(bl))
    }
  }
  const merged = mergeGeometries(list)!
  merged.computeBoundingBox()
  return merged
}

/** Per-material merge for rendering: few draw calls, rotors kept separate. */
export function mergeByMaterial(g: DroneGeometry): Map<MatKey, THREE.BufferGeometry> {
  const groups = new Map<MatKey, THREE.BufferGeometry[]>()
  for (const p of g.parts) groups.set(p.mat, [...(groups.get(p.mat) ?? []), p.geo])
  const out = new Map<MatKey, THREE.BufferGeometry>()
  for (const [k, list] of groups) out.set(k, mergeGeometries(list)!)
  return out
}

export function triangleCount(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.getAttribute('position').count / 3
}

/** Height of a built drone; used by the height solver. */
export function zExtent(spec: DroneSpec, shape?: Partial<Shape>): number {
  return buildGeometry(spec, shape).size.z
}
