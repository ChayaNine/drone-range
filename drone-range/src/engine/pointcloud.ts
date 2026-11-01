/**
 * Deterministic random numbers and surface sampling. The simulator seeds its worlds, targets and
 * rogue drones with mulberry32, so the same seed always builds the same level.
 */
import * as THREE from 'three'

/** Deterministic PRNG so the same drone always exports the same cloud. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleSurface(geo: THREE.BufferGeometry, n: number, seed = 7): Float32Array {
  const g = geo.index ? geo.toNonIndexed() : geo
  const p = g.getAttribute('position').array as ArrayLike<number>
  const nt = p.length / 9
  const cum = new Float64Array(nt)
  let tot = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < nt; i++) {
    a.fromArray(p, i * 9); b.fromArray(p, i * 9 + 3); c.fromArray(p, i * 9 + 6)
    tot += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5
    cum[i] = tot
  }
  const rnd = mulberry32(seed)
  const out = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    const r = rnd() * tot
    let lo = 0, hi = nt - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m }
    a.fromArray(p, lo * 9); b.fromArray(p, lo * 9 + 3); c.fromArray(p, lo * 9 + 6)
    let r1 = rnd(), r2 = rnd()
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2 }
    out[k * 3] = a.x + r1 * (b.x - a.x) + r2 * (c.x - a.x)
    out[k * 3 + 1] = a.y + r1 * (b.y - a.y) + r2 * (c.y - a.y)
    out[k * 3 + 2] = a.z + r1 * (b.z - a.z) + r2 * (c.z - a.z)
  }
  return out
}
