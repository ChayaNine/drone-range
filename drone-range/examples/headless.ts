/**
 * Fly a mission with no browser, no WebGL and no window: just the rules, stepped as fast as the
 * CPU allows. This is the starting point for bots, reinforcement-learning environments, balance
 * testing and anything else that wants thousands of runs.
 *
 *   npm run example:headless
 *   npm run example:headless -- src/drones/hornet-fpv.drone.json range targets 120
 *                               ^ drone file                     ^env  ^mission ^seconds
 *
 * The "pilot" below is deliberately dumb: it climbs, turns towards the nearest live target, closes
 * to firing range and shoots. It suits an armed multirotor on Target Range or Intercept; it knows
 * nothing about rings, crates or zones, and it will crash a fixed-wing. Replace `pilot()` with your
 * own controller.
 */
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { loadDrone } from '../src/lib/spec'
import { computePerformance } from '../src/engine/performance'
import { buildGeometry } from '../src/engine/geometry'
import { Game } from '../src/sim/game'
import type { Input } from '../src/sim/flight'
import { envById, missionById } from '../src/sim/catalog'

const [file = 'src/drones/warden-hexa.drone.json', envId = 'range', missionId = 'targets', seconds = '120'] = process.argv.slice(2)

const { spec } = loadDrone(readFileSync(file, 'utf8'))
const perf = computePerformance(spec)
if (!perf.flightReady) throw new Error(`${spec.name} is not flight-ready: ${perf.advice[0] ?? 'see npm run drone:check'}`)

const mission = missionById(missionId)
const unmet = mission.needs?.(spec)
if (unmet) throw new Error(`${spec.name} cannot fly ${mission.name}: ${unmet}`)

const game = new Game({ spec, perf, geo: buildGeometry(spec), env: envById(envId), mission, seed: 7 })
game.countdown = 0 // skip the 3-2-1

const STEP = 1 / 120 // the game is built for this step; the browser also runs it at 120 Hz
const fwd = new THREE.Vector3()
const to = new THREE.Vector3()

/** One decision per physics step: stick inputs in -1..1, plus whether to hold each fire button. */
function pilot(g: Game): { input: Input; fire: [boolean, boolean] } {
  const c = g.craft
  const input: Input = { pitch: 0, roll: 0, yaw: 0, throttle: c.pos.y < 18 ? 1 : 0 } // hold about 18 m
  let target = null as (typeof g.entities)[number] | null
  let best = Infinity
  for (const e of g.entities) {
    if (e.state !== 'active' || e.kind === 'crate' || e.kind === 'micro') continue
    const d = e.pos.distanceTo(c.pos)
    if (d < best) { best = d; target = e }
  }
  if (!target) return { input, fire: [false, false] }

  to.subVectors(target.pos, c.pos)
  c.forward(fwd)
  // Signed angle between where we point and where the target is, on the horizontal plane.
  // The craft turns right (clockwise from above) on positive yaw input.
  const err = Math.atan2(fwd.x * to.z - fwd.z * to.x, fwd.x * to.x + fwd.z * to.z)
  input.yaw = THREE.MathUtils.clamp(err * 2, -1, 1)
  if (best > 70) input.pitch = 0.6 // fly towards it
  // The in-game camera supplies the aim ray; headless, we hand the game one that points at the target.
  g.setAim(c.pos, to.clone().normalize())
  return { input, fire: [best < 150 && Math.abs(err) < 0.1, false] }
}

const t0 = performance.now()
const steps = Math.round(Number(seconds) * 120)
for (let i = 0; i < steps && !game.over; i++) {
  const { input, fire } = pilot(game)
  game.update(STEP, input, fire)
}
if (!game.over) game.finish('quit')
const ms = performance.now() - t0

const r = game.result!
console.log(`${spec.name} · ${mission.name} · ${envById(envId).name}`)
console.log(`  ended:    ${r.reason} after ${(r.timeMs / 1000).toFixed(1)} s of game time (${(ms).toFixed(0)} ms of CPU, ${(r.timeMs / ms).toFixed(0)}x real time)`)
console.log(`  score:    ${r.score}  (${r.stars} star${r.stars === 1 ? '' : 's'})`)
console.log(`  shooting: ${r.stats.hits} hits / ${r.stats.shots} shots, ${r.stats.kills} destroyed`)
for (const [label, pts] of r.breakdown) console.log(`    ${String(pts).padStart(6)}  ${label}`)
