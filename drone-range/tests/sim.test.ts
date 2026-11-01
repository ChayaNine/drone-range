/**
 * Simulator tests: the drone flies with the numbers in its file, and the missions are winnable.
 * These run the game loop headless (no browser, no WebGL), 120 steps per simulated second.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { loadBundled } from '../src/lib/library'
import { computePerformance } from '../src/engine/performance'
import { buildGeometry } from '../src/engine/geometry'
import { Game } from '../src/sim/game'
import { envById, missionById, ENVIRONMENTS } from '../src/sim/catalog'
import { insideSolid, buildWorld } from '../src/sim/world'

const library = loadBundled()
const rec = (slug: string) => library.find(d => d.id === `bundled-${slug}`)!
const game = (slug: string, env: string, mission: string, seed = 3) => {
  const r = rec(slug)
  const g = new Game({ spec: r.spec, perf: computePerformance(r.spec), geo: buildGeometry(r.spec), env: envById(env), mission: missionById(mission), seed })
  g.countdown = 0
  return g
}
const STEP = 1 / 120

describe('flight physics', () => {
  it('a multirotor tops out near the designer’s top speed', () => {
    const g = game('hornet-fpv', 'range', 'free')
    const vmax = computePerformance(rec('hornet-fpv').spec).speed.max
    for (let i = 0; i < 120 * 4; i++) g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: g.craft.pos.y < 40 ? 1 : 0 }, [false, false])
    for (let i = 0; i < 120 * 12; i++) g.update(STEP, { pitch: 1, roll: 0, yaw: 0, throttle: 0 }, [false, false])
    expect(g.craft.speed).toBeGreaterThan(vmax * 0.85)
    expect(g.craft.speed).toBeLessThan(vmax * 1.2)
  })

  it('an aeroplane holds altitude at cruise throttle and stalls when slowed', () => {
    const g = game('longbow-surveyor', 'range', 'free')
    for (let i = 0; i < 120 * 10; i++) g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0 }, [false, false])
    expect(g.craft.alive).toBe(true)
    expect(g.craft.agl(g.world)).toBeGreaterThan(10)
    for (let i = 0; i < 120 * 3; i++) g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: -1 }, [false, false])
    expect(g.craft.throttle).toBe(0)
  })

  it('battery drains with power draw', () => {
    const g = game('hornet-fpv', 'range', 'free')
    const e0 = g.craft.energyWh
    for (let i = 0; i < 120 * 20; i++) g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: g.craft.pos.y < 10 ? 1 : 0 }, [false, false])
    expect(g.craft.energyWh).toBeLessThan(e0)
    expect(g.craft.powerW).toBeGreaterThan(20)
  })

  it('flying into a building hurts', () => {
    const g = game('warden-hexa', 'city', 'free')
    const hp0 = g.craft.hp
    for (let i = 0; i < 120 * 2; i++) g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 1 }, [false, false])
    for (let i = 0; i < 120 * 15 && g.craft.alive && g.craft.hp === hp0; i++) g.update(STEP, { pitch: 1, roll: 0, yaw: 0, throttle: 0 }, [false, false])
    expect(g.craft.hp).toBeLessThan(hp0)
  })
})

describe('missions', () => {
  it('ring courses never pass through buildings', () => {
    for (const env of ENVIRONMENTS) {
      const g = game('hornet-fpv', env.id, 'rings')
      expect(g.rings.length).toBe(12)
      for (const r of g.rings) expect(insideSolid(g.world, r.pos, r.radius * 0.5)).toBe(false)
    }
  })

  it('target range spawns 20 targets and the turret can destroy one', () => {
    const g = game('warden-hexa', 'range', 'targets')
    const targets = g.entities.filter(e => e.kind === 'target' || e.kind === 'balloon')
    expect(targets.length).toBe(20)
    const t = targets.find(e => e.model === 'balloon')!
    // hover beside it and fire straight at it
    g.craft.pos.copy(t.pos).add(new THREE.Vector3(-15, 0, 0))
    g.craft.landed = false
    for (let i = 0; i < 120 * 6 && t.state === 'active'; i++) {
      g.setAim(g.craft.pos, t.pos.clone().sub(g.craft.pos))
      g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0 }, [true, false])
    }
    expect(t.state).not.toBe('active')
    expect(g.score).toBeGreaterThan(0)
  })

  it('a net captures a rogue drone for double points', () => {
    const g = game('kestrel-interceptor', 'range', 'intercept')
    const rogue = g.entities.find(e => e.kind === 'rogue')!
    rogue.speed = 0
    rogue.vel.set(0, 0, 0)
    g.craft.pos.copy(rogue.pos).add(new THREE.Vector3(-12, 0, 0))
    g.craft.landed = false
    let fired = false
    for (let i = 0; i < 120 * 4; i++) {
      rogue.vel.set(0, 0, 0)
      g.setAim(g.craft.pos, rogue.pos.clone().sub(g.craft.pos))
      g.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0 }, [!fired, false])
      fired = true
    }
    expect(g.stats.captures).toBe(1)
    expect(g.score).toBeGreaterThanOrEqual(rogue.value * 2)
  })

  it('worlds are deterministic for a seed', () => {
    const a = buildWorld(envById('forest'), 11), b = buildWorld(envById('forest'), 11)
    expect(a.trees.length).toBe(b.trees.length)
    expect(a.trees[5]).toEqual(b.trees[5])
  })
})
