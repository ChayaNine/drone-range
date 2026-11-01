/**
 * Make a drone file from the command line.
 *
 *   npm run drone:new -- --name "Gnat" --layout quad_x --length 0.3 --weapon kinetic --system radar
 *
 * Writes src/drones/<name>.drone.json (a short recipe), so the drone shows up on the start screen
 * after a reload. Add `--full` to write the complete spec instead, `--print` to print instead of
 * writing, `--out path.json` to choose the file, and `--force` to overwrite a file or write a drone that cannot fly.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { RECIPE_FORMAT, SpecError, buildFromRecipe, droneFile, slug, type Recipe } from '../src/lib/spec'
import { computePerformance } from '../src/engine/performance'
import { LAYOUTS } from '../src/engine/layouts'
import { SYSTEMS, WEAPONS } from '../src/engine/parts'
import type { LayoutId, Mount } from '../src/engine/types'

const { values: v } = parseArgs({
  options: {
    name: { type: 'string' }, layout: { type: 'string' }, length: { type: 'string' }, width: { type: 'string' },
    weapon: { type: 'string', multiple: true }, system: { type: 'string', multiple: true },
    out: { type: 'string' }, full: { type: 'boolean' }, print: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
})

const help = `Make a drone file.

  npm run drone:new -- --name "Gnat" --layout quad_x --length 0.3 [--width 0.3]
                       [--weapon kinetic[:belly]] [--system radar[:top]] [--full] [--print] [--out file]

  layouts : ${Object.keys(LAYOUTS).join(', ')}
  weapons : ${WEAPONS.map(w => w.id).join(', ')}      (at most 2)
  systems : ${SYSTEMS.map(s => s.id).join(', ')}      (at most 2)
  mounts  : belly, nose, top, tail, left, right  (optional; a free one is chosen)
`

if (v.help || !v.name || !v.layout || !v.length) {
  console.log(help)
  process.exit(v.help ? 0 : 1)
}

const mod = (s: string) => { const [id, mount] = s.split(':'); return mount ? { id, mount: mount as Mount } : id }
const recipe: Recipe = {
  format: RECIPE_FORMAT,
  name: v.name,
  layout: v.layout as LayoutId,
  length: Number(v.length),
  ...(v.width ? { width: Number(v.width) } : {}),
  ...(v.weapon?.length ? { weapons: v.weapon.map(mod) } : {}),
  ...(v.system?.length ? { systems: v.system.map(mod) } : {}),
}

try {
  const { spec, warnings } = buildFromRecipe(recipe)
  const p = computePerformance(spec)
  const text = v.full ? droneFile(spec) : JSON.stringify(recipe, null, 2) + '\n'
  console.log(`${spec.name}: ${p.className}, ${p.massKg.toFixed(2)} kg, ${p.speed.max.toFixed(1)} m/s, ${p.endurance.bestMin.toFixed(0)} min, thrust:weight ${p.thrust.twr.toFixed(2)}, ${p.flightReady ? 'flight-ready' : 'NOT flight-ready'}`)
  for (const w of warnings) console.log(`  ! ${w}`)
  if (v.print) { console.log('\n' + text); process.exit(0) }
  if (!p.flightReady && !v.force) { console.error('That drone cannot fly, so no file was written. Lighten the loadout, make it bigger, or pass --force to write it anyway.'); process.exit(1) }
  const out = resolve(v.out ?? `src/drones/${slug(spec.name)}.drone.json`)
  if (existsSync(out) && !v.force) { console.error(`${out} already exists. Use --force to overwrite or --out to pick another file.`); process.exit(1) }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  console.log(`Wrote ${out}`)
} catch (e) {
  if (e instanceof SpecError) { console.error(e.problems.map(p => `  - ${p}`).join('\n')); process.exit(1) }
  throw e
}
