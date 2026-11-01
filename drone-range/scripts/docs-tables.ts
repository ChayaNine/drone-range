/**
 * Reference tables for README.md and docs/, generated straight from the code so the documentation
 * can't drift from the game.
 *
 *   npm run docs:tables                  # print every table
 *   npm run docs:tables -- weapons       # print one: weapons | systems | weaponsBrief | systemsBrief | layouts | motors | missions | environments
 *   npm run docs:tables -- --write       # rewrite the tables inside README.md and docs/*.md
 *   npm run docs:tables -- --check       # exit 1 if any of them is out of date (CI runs this)
 *
 * A table lives between two comment markers in a Markdown file:
 *
 *   <!-- TABLE:weapons -->
 *   ...generated, do not edit by hand...
 *   <!-- /TABLE:weapons -->
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYOUTS } from '../src/engine/layouts'
import { MOTORS, SYSTEMS, WEAPONS } from '../src/engine/parts'
import { ENVIRONMENTS, MISSIONS } from '../src/sim/catalog'

const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')

const KIND = { ring: 'multirotor', wing_ring: 'VTOL', wing: 'aeroplane', heli: 'helicopter' } as const
const stat = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v))
/** These two are sized from the aircraft they ride on, so the catalogue's number is not the real one. */
const SCALES = new Set(['stealth', 'parachute'])

export const tables: Record<string, () => string> = {
  weapons: () => table(['id', 'Name', 'Mass', 'Power', 'Mounts', 'What it does'],
    WEAPONS.map(w => [`\`${w.id}\``, w.name, `${w.massKg} kg`, `${w.powerW} W`, w.mounts.join(', '), `${w.blurb} (${Object.entries(w.stats).map(([k, v]) => `${k} ${stat(v)}`).join(', ')})`])),
  systems: () => table(['id', 'Name', 'Mass', 'Power', 'Mounts', 'What it does'],
    SYSTEMS.map(s => [`\`${s.id}\``, s.name, SCALES.has(s.id) ? 'scales with the airframe' : `${s.massKg} kg`, s.powerW ? `${s.powerW} W` : '-', s.mounts.join(', '), s.blurb])),
  // Shorter versions for the README: no tuning numbers, mass and power in one cell.
  weaponsBrief: () => table(['id', 'Name', 'Weight · power', 'Mounts', 'What it does'],
    WEAPONS.map(w => [`\`${w.id}\``, w.name, `${w.massKg} kg · ${w.powerW} W`, w.mounts.join(', '), w.blurb])),
  systemsBrief: () => table(['id', 'Name', 'Weight · power', 'Mounts', 'What it does'],
    SYSTEMS.map(s => [`\`${s.id}\``, s.name, `${SCALES.has(s.id) ? 'scales' : `${s.massKg} kg`} · ${s.powerW ? `${s.powerW} W` : 'none'}`, s.mounts.join(', '), s.blurb])),
  layouts: () => table(['id', 'Airframe', 'Flies as', 'Notes', '`length` × `width` mean'],
    Object.entries(LAYOUTS).map(([id, l]) => [`\`${id}\``, l.label, KIND[l.kind], l.blurb, l.envelope])),
  motors: () => table(['id', 'Motor', 'Cells', 'Max power', 'Mass', 'Prop (m)'],
    MOTORS.map(m => [`\`${m.id}\``, m.label, m.minS === m.maxS ? `${m.minS}S` : `${m.minS}-${m.maxS}S`, `${m.maxPowerW} W`, `${m.massKg} kg`, `${m.propM[0]}-${m.propM[1]}`])),
  missions: () => table(['id', 'Mission', 'Clock', 'Stars at', 'Needs', 'Goal'],
    MISSIONS.map(m => [`\`${m.id}\``, `${m.glyph} ${m.name}`, m.timeLimit ? `${Math.floor(m.timeLimit / 60)}:${String(m.timeLimit % 60).padStart(2, '0')}` : 'none',
      m.id === 'free' ? '-' : m.stars.join(' / '), m.id === 'targets' ? 'turret, bombs, missiles or laser' : m.id === 'intercept' || m.id === 'survival' ? 'any weapon' : '-', m.blurb])),
  environments: () => table(['id', 'Environment', 'Wind', 'Notes'],
    ENVIRONMENTS.map(e => [`\`${e.id}\``, e.name, `${e.wind} m/s`, e.blurb])),
}

/** Replaces everything between the markers of every known table. Returns the new text. */
export function syncText(text: string): string {
  return text.replace(/<!-- TABLE:(\w+) -->[\s\S]*?<!-- \/TABLE:\1 -->/g, (_whole, name: string) => {
    const make = tables[name]
    if (!make) throw new Error(`Unknown table "${name}" in a TABLE marker. Known: ${Object.keys(tables).join(', ')}`)
    return `<!-- TABLE:${name} -->\n${make()}\n<!-- /TABLE:${name} -->`
  })
}

const root = fileURLToPath(new URL('..', import.meta.url))
const files = ['README.md', ...readdirSync(join(root, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)]

const arg = process.argv[2]
if (arg === '--write' || arg === '--check') {
  const stale: string[] = []
  for (const f of files) {
    const path = join(root, f)
    let before: string
    try { before = readFileSync(path, 'utf8') } catch { continue }
    const after = syncText(before)
    if (after === before) continue
    stale.push(f)
    if (arg === '--write') writeFileSync(path, after)
  }
  if (arg === '--check' && stale.length) {
    console.error(`Generated tables are out of date in: ${stale.join(', ')}\nRun: npm run docs:tables -- --write`)
    process.exit(1)
  }
  console.log(arg === '--write' ? (stale.length ? `Updated tables in: ${stale.join(', ')}` : 'Tables already up to date.') : 'Tables are up to date.')
} else {
  if (arg && !tables[arg]) { console.error(`Unknown table "${arg}". Choose one of: ${Object.keys(tables).join(', ')}, or --write / --check`); process.exit(1) }
  for (const [name, fn] of Object.entries(tables)) {
    if (arg && arg !== name) continue
    console.log(`<!-- TABLE:${name} -->\n${fn()}\n<!-- /TABLE:${name} -->\n`)
  }
}
