/**
 * Check every drone file in src/drones/ (or the paths you pass) and print what the simulator will
 * make of it. Exits 1 if any file fails to load or cannot fly, so it is safe to run in CI.
 *
 *   npm run drone:check
 *   npm run drone:check -- my-drone.json
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { SpecError, loadDrone } from '../src/lib/spec'
import { computePerformance } from '../src/engine/performance'

const dir = resolve('src/drones')
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map(f => resolve(f))
  : readdirSync(dir).filter(f => f.endsWith('.drone.json')).sort().map(f => join(dir, f))

let bad = 0
const rows: string[][] = [['file', 'drone', 'class', 'kg', 'm/s', 'min', 'T:W', 'loadout', 'status']]
for (const f of files) {
  try {
    const { spec, warnings } = loadDrone(readFileSync(f, 'utf8'))
    const p = computePerformance(spec)
    const load = [...spec.weapons, ...spec.systems].map(m => m.id).join('+') || '-'
    const status = !p.flightReady ? 'NOT READY' : warnings.length ? 'ok (warnings)' : 'ok'
    if (!p.flightReady) bad++
    rows.push([basename(f), spec.name, p.className, p.massKg.toFixed(2), p.speed.max.toFixed(1), p.endurance.bestMin.toFixed(0), p.thrust.twr.toFixed(2), load, status])
    for (const w of warnings) rows.push(['', `  ! ${w}`, '', '', '', '', '', '', ''])
  } catch (e) {
    bad++
    rows.push([basename(f), '', '', '', '', '', '', '', 'FAILED'])
    const probs = e instanceof SpecError ? e.problems : [(e as Error).message]
    for (const p of probs) rows.push(['', `  - ${p}`, '', '', '', '', '', '', ''])
  }
}
const w = rows[0].map((_, i) => Math.max(...rows.map(r => (i === 1 && r[1].startsWith('  ') ? 0 : r[i].length))))
for (const r of rows) console.log(r[1].startsWith('  ') ? r[1] : r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd())
console.log(`\n${files.length - bad} of ${files.length} drones ready to fly.`)
process.exit(bad ? 1 : 0)
