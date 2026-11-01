/**
 * Performance-model tests: the numbers that drive the simulator (mass, thrust, speed, endurance)
 * stay plausible for every airframe, and a heavier loadout costs what it should.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LAYOUTS } from '../src/engine/layouts'
import { newDesign } from '../src/engine/presets'
import { computePerformance, autoBalance } from '../src/engine/performance'
import { buildGeometry, mergeDrone, triangleCount } from '../src/engine/geometry'
import { SLOT_CAPS } from '../src/config'
import { WEAPONS, SYSTEMS } from '../src/engine/parts'
import { loadBundled } from '../src/lib/library'

const SIZE: Record<string, [number, number]> = { fixed_wing: [1.2, 2.2], vtol_quadplane: [1.3, 2.2], heli: [1.6, 1.3] }

describe('designs', () => {
  it.each(Object.keys(LAYOUTS))('a fresh %s design is flight-ready and plausible', id => {
    const [L, W] = SIZE[id] ?? [0.6, 0.6]
    const spec = newDesign(id as keyof typeof LAYOUTS, L, W)
    const p = computePerformance(spec)
    expect(p.flightReady, p.advice.join('; ')).toBe(true)
    expect(p.massKg).toBeGreaterThan(0.05)
    expect(p.speed.max).toBeGreaterThan(5)
    expect(p.speed.max).toBeLessThan(90)
    expect(p.endurance.bestMin).toBeGreaterThan(3)
    if (LAYOUTS[id as keyof typeof LAYOUTS].kind !== 'wing') expect(p.thrust.twr).toBeGreaterThan(1.5)
  })

  it('every bundled drone is flight-ready', () => {
    const drones = loadBundled()
    expect(drones.length).toBeGreaterThanOrEqual(9)
    for (const d of drones) expect(computePerformance(d.spec).flightReady, d.spec.name).toBe(true)
  })

  it('adding a heavy weapon costs mass and endurance', () => {
    const base = newDesign('quad_x', 0.8, 0.8)
    const armed = autoBalance({ ...base, weapons: [{ id: 'kinetic', mount: 'belly' }] })
    const a = computePerformance(base), b = computePerformance(armed)
    expect(b.massKg).toBeGreaterThan(a.massKg + 1)
    expect(b.endurance.bestMin).toBeLessThan(a.endurance.bestMin)
  })

  it('the model is centred and its size matches the envelope', () => {
    const spec = newDesign('hexa_x', 1.1, 1.1)
    const g = buildGeometry(spec)
    const c = g.bbox.getCenter(new THREE.Vector3())
    expect(c.length()).toBeLessThan(1e-6)
    expect(Math.max(g.size.x, g.size.y)).toBeGreaterThan(0.95)
    expect(Math.max(g.size.x, g.size.y)).toBeLessThan(1.25)
    expect(triangleCount(mergeDrone(g))).toBeGreaterThan(500)
  })
})

describe('loadout rules', () => {
  it('caps are two weapons and two systems', () => {
    expect(SLOT_CAPS).toEqual({ weapons: 2, systems: 2 })
  })
  it('every module has mass, mounts and a description', () => {
    for (const m of [...WEAPONS, ...SYSTEMS]) {
      expect(m.massKg).toBeGreaterThanOrEqual(0)
      expect(m.mounts.length).toBeGreaterThan(0)
      expect(m.blurb.length).toBeGreaterThan(10)
    }
  })
})
