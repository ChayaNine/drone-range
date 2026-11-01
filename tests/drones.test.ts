/**
 * Drone files: the two accepted formats load, bad files are rejected with a message that says
 * what to fix, and a spec survives being written out and read back in.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDrone, droneFile, SpecError, SPEC_FORMAT, RECIPE_FORMAT } from '../src/lib/spec'
import { loadBundled } from '../src/lib/library'
import { computePerformance } from '../src/engine/performance'
import { newDesign } from '../src/engine/presets'

const problems = (input: unknown): string[] => {
  try { loadDrone(input) } catch (e) { if (e instanceof SpecError) return e.problems; throw e }
  return []
}

describe('recipes', () => {
  it('the smallest recipe flies', () => {
    const { spec, kind } = loadDrone({ name: 'Tiny', layout: 'quad_x', length: 0.3 })
    expect(kind).toBe('recipe')
    const p = computePerformance(spec)
    expect(p.flightReady).toBe(true)
    expect(p.thrust.twr).toBeGreaterThan(1.5)
  })

  it('picks a free mount for modules that do not name one', () => {
    const { spec } = loadDrone({ format: RECIPE_FORMAT, name: 'Armed', layout: 'hexa_x', length: 1.1, weapons: ['kinetic', 'missile'], systems: ['radar', 'smoke'] })
    const mounts = [...spec.weapons, ...spec.systems].map(m => m.mount)
    expect(new Set(mounts).size).toBe(mounts.length)
    expect(computePerformance(spec).flightReady).toBe(true)
  })

  it('sizes motors and battery around a heavy loadout', () => {
    const light = loadDrone({ name: 'A', layout: 'quad_x', length: 0.8 }).spec
    const heavy = loadDrone({ name: 'B', layout: 'quad_x', length: 0.8, weapons: ['kinetic'], systems: ['radar'] }).spec
    expect(computePerformance(heavy).massKg).toBeGreaterThan(computePerformance(light).massKg + 1.5)
    expect(computePerformance(heavy).thrust.twr).toBeGreaterThan(1.5)
  })

  it('rejects unknown modules and says what the choices are', () => {
    const p = problems({ name: 'X', layout: 'quad_x', length: 0.5, weapons: ['railgun'] })
    expect(p.join(' ')).toMatch(/"railgun" is not known.*kinetic/)
  })

  it('rejects a mount a module cannot use', () => {
    expect(problems({ name: 'X', layout: 'quad_x', length: 0.8, weapons: [{ id: 'kinetic', mount: 'top' }] }).join(' ')).toMatch(/kinetic cannot hang on the top.*belly, nose/)
  })

  it('enforces the slot caps', () => {
    expect(problems({ name: 'X', layout: 'hexa_x', length: 1.2, weapons: ['kinetic', 'bomb', 'net'] }).join(' ')).toMatch(/at most 2/)
  })

  it('rejects bad layouts, sizes and missing names', () => {
    expect(problems({ name: 'X', layout: 'blimp', length: 0.5 }).join(' ')).toMatch(/layout "blimp".*quad_x/)
    expect(problems({ name: 'X', layout: 'quad_x', length: 40 }).join(' ')).toMatch(/calibrated/)
    expect(problems({ name: 'X', layout: 'quad_x', length: 'big' }).join(' ')).toMatch(/must be a number/)
    expect(problems({ layout: 'quad_x', length: 0.5 }).join(' ')).toMatch(/name is required/)
  })

  it('reports every problem at once', () => {
    expect(problems({ name: 'X', layout: 'quad_x', length: 0.5, weapons: ['nope'], systems: ['nada'] }).length).toBe(2)
  })
})

describe('full specs', () => {
  const spec = newDesign('quad_x', 0.6, 0.6, 'Roundtrip')

  it('survive being written and read back', () => {
    const text = droneFile(spec)
    const back = loadDrone(text)
    expect(back.kind).toBe('spec')
    expect(back.spec.name).toBe('Roundtrip')
    expect(back.spec.layout).toBe('quad_x')
    expect(back.spec.envelope.length).toBeCloseTo(0.6)
    expect(back.spec.internals.battery.capacityMah).toBe(spec.internals.battery.capacityMah)
    expect(computePerformance(back.spec).massKg).toBeCloseTo(computePerformance(spec).massKg, 6)
  })

  it('accepts a Drone Surrogate Factory export and a bare spec', () => {
    expect(loadDrone({ format: SPEC_FORMAT, spec }).spec.name).toBe('Roundtrip')
    expect(loadDrone(spec).spec.name).toBe('Roundtrip')
  })

  it('fills in anything a hand-trimmed file leaves out', () => {
    const { spec: s } = loadDrone({ version: 3, name: 'Trimmed', layout: 'hexa_x', envelope: { length: 1, width: 1 } })
    expect(s.ratios.rotor).toBeGreaterThan(0)
    expect(s.internals.motorId).toBeTruthy()
    expect(computePerformance(s).massKg).toBeGreaterThan(0)
  })

  it('drops an imported mesh with a warning instead of failing', () => {
    const { warnings } = loadDrone({ ...spec, imported: { storageKey: 'x', originalName: 'x.stl', format: 'stl', triangles: 10 } })
    expect(warnings.join(' ')).toMatch(/imported 3D mesh/)
  })

  it('names the field when an enum is wrong', () => {
    const bad = { ...spec, body: { ...spec.body, shape: 'sphere' } }
    expect(problems(bad).join(' ')).toMatch(/body\.shape "sphere"/)
  })

  it('rejects things that are not drones', () => {
    expect(problems('{ nope')).toEqual([expect.stringMatching(/Not valid JSON/)])
    expect(problems([1, 2])).toEqual([expect.stringMatching(/Expected an object/)])
    expect(problems({ hello: 'world' }).join(' ')).toMatch(/not a drone file/)
  })
})

describe('files from Drone Surrogate Factory', () => {
  it('a real .drone.json export loads unchanged and can fly', () => {
    // Written by the factory's own exporter (specDocument), not by this repo.
    const text = readFileSync(new URL('./fixtures/factory-export.drone.json', import.meta.url), 'utf8')
    const { spec, kind, warnings } = loadDrone(text)
    expect(kind).toBe('spec')
    expect(spec.name).toBe('Factory Export Fixture')
    expect(spec.weapons.map(w => w.id)).toEqual(['kinetic'])
    expect(warnings).toEqual([])
    expect(computePerformance(spec).flightReady).toBe(true)
  })
})

describe('bundled drones', () => {
  it('every file in src/drones loads with no warnings', () => {
    const drones = loadBundled()
    expect(drones.map(d => d.id)).toContain('bundled-starter-quad')
    for (const d of drones) expect(d.warnings, d.spec.name).toEqual([])
  })

  it('skips a broken file instead of crashing', () => {
    const out = loadBundled({ '../drones/ok.drone.json': { name: 'Ok', layout: 'quad_x', length: 0.4 }, '../drones/broken.drone.json': { name: 'Bad', layout: 'nope', length: 1 } })
    expect(out.map(d => d.id)).toEqual(['bundled-ok'])
  })
})
