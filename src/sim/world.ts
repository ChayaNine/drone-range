/**
 * Procedural worlds. Deterministic from (environment, seed), Y-up, metres: x east, z south.
 * Everything a projectile, a LiDAR beam or the drone can hit is described here analytically,
 * so physics and the live LiDAR share one source of truth with what is drawn.
 */
import * as THREE from 'three'
import { mulberry32 } from '../engine/pointcloud'
import type { EnvDef, EnvId } from './catalog'

export interface Building { min: THREE.Vector3; max: THREE.Vector3; color: string; lit: boolean }
export interface Tree { x: number; z: number; y: number; h: number; r: number }
export interface Box { min: THREE.Vector3; max: THREE.Vector3; color: string }

export interface World {
  env: EnvDef
  half: number
  seed: number
  height: (x: number, z: number) => number
  water: boolean
  buildings: Building[]
  boxes: Box[]
  trees: Tree[]
  lamps: THREE.Vector3[]
  spawn: THREE.Vector3
  spawnYaw: number
  wind: THREE.Vector3
  gust: number
}

/** Smooth value noise, good enough for terrain. */
function noise2(seed: number) {
  const rnd = mulberry32(seed)
  const perm = new Float32Array(512)
  for (let i = 0; i < 512; i++) perm[i] = rnd()
  const h = (x: number, z: number) => perm[(((x * 73856093) ^ (z * 19349663)) >>> 0) % 512]
  const s = (t: number) => t * t * (3 - 2 * t)
  return (x: number, z: number) => {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi
    const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1)
    const u = s(xf), v = s(zf)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

export function buildWorld(env: EnvDef, seed = 7, windOverride?: number): World {
  const rnd = mulberry32(seed * 7919 + env.id.length)
  const n1 = noise2(seed), n2 = noise2(seed + 1)
  const half = 800
  const fbm = (x: number, z: number, f: number) => n1(x * f, z * f) * 0.6 + n2(x * f * 2.3, z * f * 2.3) * 0.3
  const pad = (x: number, z: number) => Math.min(1, Math.hypot(x, z) / 60) // flatten around the launch pad
  let height: (x: number, z: number) => number
  const kind: EnvId = env.id
  if (kind === 'forest') height = (x, z) => (fbm(x, z, 1 / 140) - 0.45) * 60 * pad(x, z) + Math.max(0, Math.hypot(x, z) - 500) * 0.25
  else if (kind === 'range') height = (x, z) => (fbm(x, z, 1 / 220) - 0.45) * 8 * pad(x, z) + Math.max(0, Math.hypot(x, z) - 550) * 0.35
  else if (kind === 'harbor') height = (x, _z) => (x < -40 ? 2.5 : -6)
  else height = () => 0

  const buildings: Building[] = []
  const boxes: Box[] = []
  const trees: Tree[] = []
  const lamps: THREE.Vector3[] = []

  if (kind === 'city' || kind === 'night') {
    const palette = kind === 'night' ? ['#1d2129', '#232831', '#1a1e25', '#272c35'] : ['#b9c0c8', '#9aa4ae', '#c8c1b3', '#8892a0', '#d3d6da', '#a6b0a8']
    for (let bx = -6; bx <= 6; bx++) for (let bz = -6; bz <= 6; bz++) {
      if (Math.abs(bx) <= 0 && Math.abs(bz) <= 0) continue // central plaza with the pad
      const cx = bx * 80, cz = bz * 80
      const dist = Math.hypot(cx, cz)
      const lots = rnd() < 0.3 ? 1 : 2
      for (let l = 0; l < lots; l++) {
        const w = lots === 1 ? 46 + rnd() * 10 : 22 + rnd() * 6
        const d = 40 + rnd() * 14
        const ox = lots === 1 ? 0 : (l ? 15 : -15)
        const hgt = Math.max(8, (140 - dist * 0.16) * (0.35 + rnd() * 0.75))
        buildings.push({
          min: new THREE.Vector3(cx + ox - w / 2, 0, cz - d / 2), max: new THREE.Vector3(cx + ox + w / 2, hgt, cz + d / 2),
          color: palette[Math.floor(rnd() * palette.length)], lit: kind === 'night',
        })
      }
      if (kind === 'night') lamps.push(new THREE.Vector3(cx + 40, 6, cz + 40))
    }
  }

  if (kind === 'forest' || kind === 'range') {
    const nTrees = kind === 'forest' ? 1100 : 70
    for (let i = 0; i < nTrees; i++) {
      const x = (rnd() - 0.5) * 1300, z = (rnd() - 0.5) * 1300
      if (Math.hypot(x, z) < 45) continue
      if (kind === 'range' && rnd() < 0.5) continue
      const h = kind === 'forest' ? 12 + rnd() * 16 : 3 + rnd() * 3
      trees.push({ x, z, y: height(x, z), h, r: h * (kind === 'forest' ? 0.2 : 0.45) })
    }
    if (kind === 'range') {
      // test-range structures: hangars and berms
      for (let i = 0; i < 6; i++) {
        const a = rnd() * Math.PI * 2, r = 160 + rnd() * 260
        const x = Math.cos(a) * r, z = Math.sin(a) * r, y = height(x, z)
        boxes.push({ min: new THREE.Vector3(x - 14, y, z - 9), max: new THREE.Vector3(x + 14, y + 9, z + 9), color: '#a9a39a' })
      }
    }
  }

  if (kind === 'harbor') {
    const cols = ['#c0392b', '#2471a3', '#d4ac0d', '#1e8449', '#7d3c98', '#ca6f1e', '#5d6d7e']
    for (let i = 0; i < 9; i++) for (let j = 0; j < 6; j++) {
      const stack = 1 + Math.floor(rnd() * 4)
      const x = -360 + i * 34, z = -150 + j * 16
      boxes.push({ min: new THREE.Vector3(x, 2.5, z), max: new THREE.Vector3(x + 12.2, 2.5 + 2.6 * stack, z + 2.45), color: cols[Math.floor(rnd() * cols.length)] })
    }
    // cranes
    for (let i = 0; i < 3; i++) {
      const x = -70, z = -200 + i * 140
      boxes.push({ min: new THREE.Vector3(x - 2, 2.5, z - 2), max: new THREE.Vector3(x + 2, 52, z + 2), color: '#e6b31e' })
      boxes.push({ min: new THREE.Vector3(x - 40, 48, z - 1.5), max: new THREE.Vector3(x + 60, 52, z + 1.5), color: '#e6b31e' })
    }
    // cargo ship
    boxes.push({ min: new THREE.Vector3(120, -4, -40), max: new THREE.Vector3(300, 12, -8), color: '#2c3e50' })
    boxes.push({ min: new THREE.Vector3(260, 12, -36), max: new THREE.Vector3(292, 34, -12), color: '#ecf0f1' })
    for (let i = 0; i < 6; i++) boxes.push({ min: new THREE.Vector3(140 + i * 18, 12, -36), max: new THREE.Vector3(152 + i * 18, 12 + 2.6 * (1 + (i % 3)), -12), color: cols[i % cols.length] })
  }

  const ang = rnd() * Math.PI * 2
  const windSpeed = windOverride ?? env.wind
  const spawnY = kind === 'harbor' ? 2.5 : height(0, 0)
  return {
    env, half, seed, height, water: kind === 'harbor',
    buildings, boxes, trees, lamps,
    spawn: new THREE.Vector3(kind === 'harbor' ? -120 : 0, spawnY, 0), spawnYaw: 0,
    wind: new THREE.Vector3(Math.cos(ang) * windSpeed, 0, Math.sin(ang) * windSpeed),
    gust: windSpeed * 0.35,
  }
}

/** Surface height including water. */
export function groundAt(w: World, x: number, z: number) {
  const h = w.height(x, z)
  return w.water ? Math.max(h, 0) : h
}

/** True if the point is inside any solid (building, box, tree trunk or crown), with a margin. */
export function insideSolid(w: World, p: THREE.Vector3, margin = 0): boolean {
  for (const b of w.buildings) if (p.x > b.min.x - margin && p.x < b.max.x + margin && p.y < b.max.y + margin && p.z > b.min.z - margin && p.z < b.max.z + margin) return true
  for (const b of w.boxes) if (p.x > b.min.x - margin && p.x < b.max.x + margin && p.y > b.min.y - margin && p.y < b.max.y + margin && p.z > b.min.z - margin && p.z < b.max.z + margin) return true
  for (const t of w.trees) {
    const dx = p.x - t.x, dz = p.z - t.z
    if (dx * dx + dz * dz > (t.r + margin + 1) ** 2) continue
    const top = t.y + t.h
    if (p.y < t.y + t.h * 0.35 && dx * dx + dz * dz < (0.35 + margin) ** 2) return true
    const cy = t.y + t.h * 0.62
    const ry = t.h * 0.42
    if (((dx * dx + dz * dz) / ((t.r + margin) ** 2)) + ((p.y - cy) ** 2) / ((ry + margin) ** 2) < 1 && p.y < top) return true
  }
  return false
}

/** Ray against the world. Returns distance or Infinity. Used by the live LiDAR and line of sight. */
export function raycastWorld(w: World, o: THREE.Vector3, d: THREE.Vector3, maxT: number): { t: number; kind: 'ground' | 'water' | 'building' | 'tree' } | null {
  let best = maxT, kind: 'ground' | 'water' | 'building' | 'tree' | null = null
  const slab = (min: THREE.Vector3, max: THREE.Vector3) => {
    let t0 = -Infinity, t1 = Infinity
    for (const ax of ['x', 'y', 'z'] as const) {
      const inv = 1 / (d[ax] || 1e-12)
      let a = (min[ax] - o[ax]) * inv, b = (max[ax] - o[ax]) * inv
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a); t1 = Math.min(t1, b)
      if (t1 < t0) return Infinity
    }
    return t0 > 0 ? t0 : t1 > 0 ? 0 : Infinity
  }
  for (const b of w.buildings) { const t = slab(b.min, b.max); if (t < best) { best = t; kind = 'building' } }
  for (const b of w.boxes) { const t = slab(b.min, b.max); if (t < best) { best = t; kind = 'building' } }
  for (const tr of w.trees) {
    // quick reject in xz, then sphere-ish crown
    const cx = tr.x - o.x, cz = tr.z - o.z, cy = tr.y + tr.h * 0.62 - o.y
    const along = cx * d.x + cy * d.y + cz * d.z
    if (along < 0 || along > best) continue
    const perp2 = cx * cx + cy * cy + cz * cz - along * along
    const rr = Math.max(tr.r, tr.h * 0.42)
    if (perp2 < rr * rr) { const t = along - Math.sqrt(rr * rr - perp2); if (t > 0 && t < best) { best = t; kind = 'tree' } }
  }
  // terrain: march then bisect
  const step = Math.max(2, best / 64)
  let prevT = 0, prevAbove = o.y - groundAt(w, o.x, o.z)
  for (let t = step; t <= best; t += step) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t
    const above = y - groundAt(w, x, z)
    if (above < 0 && prevAbove >= 0) {
      let lo = prevT, hi = t
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) / 2
        if (o.y + d.y * m - groundAt(w, o.x + d.x * m, o.z + d.z * m) < 0) hi = m; else lo = m
      }
      if (hi < best) { best = hi; kind = w.water && o.y + d.y * hi < 0.3 ? 'water' : 'ground' }
      break
    }
    prevT = t; prevAbove = above
  }
  return kind ? { t: best, kind } : null
}

/** A copy of the world that only holds solids near a point. Rays inside `radius` give identical answers, much faster. */
export function worldNear(w: World, c: THREE.Vector3, radius: number): World {
  const r = radius
  const nearBox = (b: { min: THREE.Vector3; max: THREE.Vector3 }) =>
    b.max.x > c.x - r && b.min.x < c.x + r && b.max.z > c.z - r && b.min.z < c.z + r && b.min.y < c.y + r
  return {
    ...w,
    buildings: w.buildings.filter(nearBox),
    boxes: w.boxes.filter(nearBox),
    trees: w.trees.filter(t => Math.abs(t.x - c.x) < r + t.r && Math.abs(t.z - c.z) < r + t.r),
  }
}

const _d = new THREE.Vector3()
/** Segment a→b against the world. Returns the fraction along the segment of the first hit, or null. */
export function segmentHitsWorld(w: World, a: THREE.Vector3, b: THREE.Vector3): { f: number; kind: string } | null {
  _d.subVectors(b, a)
  const len = _d.length()
  if (len < 1e-6) return null
  // ground first: cheap and the most common hit
  if (b.y < groundAt(w, b.x, b.z)) {
    let lo = 0, hi = 1
    for (let i = 0; i < 10; i++) {
      const m = (lo + hi) / 2
      const x = a.x + _d.x * m, y = a.y + _d.y * m, z = a.z + _d.z * m
      if (y < groundAt(w, x, z)) hi = m; else lo = m
    }
    const solid = solidOnSegment(w, a, b, hi)
    if (solid) return solid
    return { f: hi, kind: w.water && a.y + _d.y * hi < 0.3 ? 'water' : 'ground' }
  }
  return solidOnSegment(w, a, b, 1)
}

function solidOnSegment(w: World, a: THREE.Vector3, b: THREE.Vector3, maxF: number): { f: number; kind: string } | null {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z)
  let best = maxF, kind: string | null = null
  const d = _d
  const slab = (min: THREE.Vector3, max: THREE.Vector3) => {
    let t0 = 0, t1 = best
    for (const ax of ['x', 'y', 'z'] as const) {
      const inv = 1 / (d[ax] || 1e-12)
      let p = (min[ax] - a[ax]) * inv, q = (max[ax] - a[ax]) * inv
      if (p > q) [p, q] = [q, p]
      t0 = Math.max(t0, p); t1 = Math.min(t1, q)
      if (t1 < t0) return Infinity
    }
    return t0
  }
  for (const list of [w.buildings, w.boxes]) for (const o of list) {
    if (o.max.x < minX || o.min.x > maxX || o.max.z < minZ || o.min.z > maxZ || o.max.y < minY) continue
    const t = slab(o.min, o.max)
    if (t < best) { best = t; kind = 'building' }
  }
  for (const tr of w.trees) {
    if (tr.x + tr.r < minX || tr.x - tr.r > maxX || tr.z + tr.r < minZ || tr.z - tr.r > maxZ || tr.y + tr.h < minY) continue
    // crown as a sphere
    const cy = tr.y + tr.h * 0.62, rr = Math.max(tr.r, tr.h * 0.42)
    const len2 = d.lengthSq()
    const fx = a.x - tr.x, fy = a.y - cy, fz = a.z - tr.z
    const B = (fx * d.x + fy * d.y + fz * d.z) / len2
    const C = (fx * fx + fy * fy + fz * fz - rr * rr) / len2
    const disc = B * B - C
    if (disc < 0) continue
    const t = -B - Math.sqrt(disc)
    if (t >= 0 && t < best) { best = t; kind = 'tree' }
  }
  return kind ? { f: best, kind } : null
}

/** Find a clear spot: on the ground (alt=0) or `alt` metres above it, not inside anything. */
export function freeSpot(w: World, rnd: () => number, cx: number, cz: number, rMin: number, rMax: number, alt: number, clearance: number, dry = true): THREE.Vector3 {
  const p = new THREE.Vector3()
  for (let i = 0; i < 80; i++) {
    const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin)
    p.set(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r)
    if (Math.abs(p.x) > w.half - 30 || Math.abs(p.z) > w.half - 30) continue
    const h = w.height(p.x, p.z)
    if (dry && w.water && h < 0.5) continue
    p.y = groundAt(w, p.x, p.z) + alt
    if (insideSolid(w, p, clearance) || insideSolid(w, new THREE.Vector3(p.x, p.y + clearance, p.z), clearance)) continue
    if (alt === 0 && insideSolid(w, new THREE.Vector3(p.x, p.y + 0.5, p.z), clearance)) continue
    return p
  }
  return p
}
