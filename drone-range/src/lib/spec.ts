/**
 * Loading drones.
 *
 * Two JSON shapes are accepted, both by the in-app "Add a drone" button and by the files you drop
 * into src/drones/:
 *
 *   1. A full drone spec, as exported by Drone Surrogate Factory ("drone-surrogate-spec/3"), or the
 *      bare spec object. Missing fields are filled from sensible defaults, so a hand-trimmed file works.
 *   2. A short "recipe": name, layout, size and a loadout. The motor, battery and CG are sized for you.
 *
 * Everything is validated with messages that say what to fix. Nothing here touches the DOM.
 */
import type { AvionicsTier, Chemistry, DroneSpec, FrameMaterial, LayoutId, Livery, Mount, PropMaterial } from '../engine/types'
import { LAYOUTS } from '../engine/layouts'
import { AVIONICS, CHEMISTRY, FRAME_MATERIALS, MOTORS, PROP_MATERIALS, SYSTEMS, WEAPONS, systemById, weaponById, type ModuleDef } from '../engine/parts'
import { defaultSpec } from '../engine/shape'
import { autoBalance, computePerformance } from '../engine/performance'
import { sizeBattery, sizePropulsion } from '../engine/presets'
import { SLOT_CAPS } from '../config'

export const SPEC_FORMAT = 'drone-surrogate-spec/3'
export const RECIPE_FORMAT = 'drone-range/recipe/1'

/** Smallest and largest airframe the physics model is calibrated for, in metres (longest side). */
export const SIZE_LIMITS = { min: 0.08, max: 6 } as const

export interface Recipe {
  format?: typeof RECIPE_FORMAT
  name: string
  layout: LayoutId
  /** Metres, nose to tail (aircraft) or rotor tip to rotor tip (multirotors). */
  length: number
  /** Metres. Defaults to `length`. For aeroplanes this is the wingspan. */
  width?: number
  /** Weapon ids, or { id, mount } to choose where it hangs. At most two. */
  weapons?: (string | { id: string; mount?: Mount })[]
  /** System ids, or { id, mount }. At most two. */
  systems?: (string | { id: string; mount?: Mount })[]
  body?: Partial<DroneSpec['body']>
  livery?: Partial<Livery>
  avionics?: AvionicsTier
  frameMaterial?: FrameMaterial
  propMaterial?: PropMaterial
  /** Leave out to let the sizer pick: it starts from the airframe's default and switches to LiPo if the motors need the current. */
  chemistry?: Chemistry
  notes?: string
}

export interface LoadedDrone {
  spec: DroneSpec
  /** Things that were changed or ignored but did not stop the drone loading. */
  warnings: string[]
  kind: 'spec' | 'recipe'
}

export class SpecError extends Error {
  constructor(public problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems:\n- ${problems.join('\n- ')}`)
    this.name = 'SpecError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v)
const list = (xs: readonly string[]) => xs.join(', ')
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i

const LAYOUT_IDS = Object.keys(LAYOUTS)
const MOUNTS: Mount[] = ['belly', 'nose', 'top', 'tail', 'left', 'right']

/** Checks the length/width pair that every airframe needs. */
function checkSize(L: unknown, W: unknown, problems: string[], where: string) {
  for (const [k, v] of [['length', L], ['width', W]] as const) {
    if (!num(v)) problems.push(`${where}${k} must be a number of metres (got ${JSON.stringify(v)}).`)
    else if (v < SIZE_LIMITS.min || v > SIZE_LIMITS.max) problems.push(`${where}${k} is ${v} m. The model is calibrated for ${SIZE_LIMITS.min} to ${SIZE_LIMITS.max} m.`)
  }
}

/** Checks a weapons/systems list: known ids, allowed mounts, the slot caps and shared mounts. */
function checkLoadout(items: unknown, kind: 'weapons' | 'systems', problems: string[]) {
  const defs: readonly ModuleDef<string>[] = kind === 'weapons' ? WEAPONS : SYSTEMS
  const cap = SLOT_CAPS[kind]
  if (!Array.isArray(items)) { problems.push(`${kind} must be a list.`); return }
  if (items.length > cap) problems.push(`${kind} has ${items.length} entries; a drone carries at most ${cap}.`)
  items.forEach((m, i) => {
    if (!isObj(m)) { problems.push(`${kind}[${i}] must look like { "id": "...", "mount": "..." }.`); return }
    const def = defs.find(d => d.id === m.id)
    if (!def) { problems.push(`${kind}[${i}].id "${String(m.id)}" is not a known ${kind === 'weapons' ? 'weapon' : 'system'}. Choose one of: ${list(defs.map(d => d.id))}.`); return }
    if (!oneOf(MOUNTS, m.mount)) problems.push(`${kind}[${i}].mount "${String(m.mount)}" is not a mount. Choose one of: ${list(MOUNTS)}.`)
    else if (!def.mounts.includes(m.mount as Mount)) problems.push(`${def.id} cannot hang on the ${String(m.mount)}. It fits: ${list(def.mounts)}.`)
  })
}

/** Validates a drone spec, filling gaps from defaults. Throws SpecError listing every problem. */
export function validateSpec(raw: unknown): LoadedDrone {
  const problems: string[] = []
  const warnings: string[] = []
  if (!isObj(raw)) throw new SpecError(['A drone spec must be a JSON object.'])
  const o = raw
  if (o.version !== undefined && o.version !== 3) problems.push(`version is ${JSON.stringify(o.version)}; this build reads version 3.`)
  if (!oneOf(LAYOUT_IDS, o.layout)) problems.push(`layout "${String(o.layout)}" is not known. Choose one of: ${list(LAYOUT_IDS)}.`)
  const env = isObj(o.envelope) ? o.envelope : {}
  if (!isObj(o.envelope)) problems.push('envelope must look like { "length": 0.5, "width": 0.5 } in metres.')
  else checkSize(env.length, env.width, problems, 'envelope.')
  if (problems.length) throw new SpecError(problems)

  const layout = o.layout as LayoutId
  const L = env.length as number, W = env.width as number
  const base = defaultSpec(layout, L, W, typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Unnamed drone')
  const part = <T extends object>(b: T, v: unknown, name: string): T => {
    if (v === undefined) return b
    if (!isObj(v)) { problems.push(`${name} must be an object.`); return b }
    return { ...b, ...v } as T
  }
  const internalsIn = isObj(o.internals) ? o.internals : {}
  const spec: DroneSpec = {
    ...base,
    origin: oneOf(['design', 'replica', 'import', 'remix'], o.origin) ? (o.origin as DroneSpec['origin']) : 'design',
    heightLocked: o.heightLocked === true,
    envelope: { length: L, width: W, height: num(env.height) && env.height >= 0 ? env.height : 0 },
    ratios: part(base.ratios, o.ratios, 'ratios'),
    body: part(base.body, o.body, 'body'),
    internals: {
      ...part(base.internals, o.internals, 'internals'),
      battery: part(base.internals.battery, internalsIn.battery, 'internals.battery'),
    },
    livery: part(base.livery, o.livery, 'livery'),
    weapons: (o.weapons ?? []) as DroneSpec['weapons'],
    systems: (o.systems ?? []) as DroneSpec['systems'],
    rotorDiameterOverride: num(o.rotorDiameterOverride) && o.rotorDiameterOverride > 0 ? o.rotorDiameterOverride : undefined,
    publishedMassKg: num(o.publishedMassKg) && o.publishedMassKg > 0 ? o.publishedMassKg : undefined,
    notes: typeof o.notes === 'string' ? o.notes.slice(0, 500) : undefined,
    evidence: isObj(o.evidence) ? (o.evidence as unknown as DroneSpec['evidence']) : undefined,
  }
  if (o.imported !== undefined) warnings.push('This drone used an imported 3D mesh. Meshes are not part of the file, so it is drawn with its generic airframe instead.')

  for (const [k, v] of Object.entries(spec.ratios)) if (!num(v)) problems.push(`ratios.${k} must be a number.`)
  const b = spec.body
  if (!oneOf(['capsule', 'box', 'pod', 'tube', 'wedge'], b.shape)) problems.push(`body.shape "${String(b.shape)}" must be one of: capsule, box, pod, tube, wedge.`)
  if (!oneOf(['skids', 'legs', 'rails', 'none'], b.gear)) problems.push(`body.gear "${String(b.gear)}" must be one of: skids, legs, rails, none.`)
  if (!oneOf(['conventional', 't_tail', 'v_tail', 'none'], b.tail)) problems.push(`body.tail "${String(b.tail)}" must be one of: conventional, t_tail, v_tail, none.`)
  if (!oneOf(['nose', 'pusher'], b.thrust)) problems.push(`body.thrust "${String(b.thrust)}" must be nose or pusher.`)
  const i = spec.internals
  if (!oneOf(MOTORS.map(m => m.id), i.motorId)) problems.push(`internals.motorId "${String(i.motorId)}" is not a motor. Choose one of: ${list(MOTORS.map(m => m.id))}.`)
  if (!oneOf(Object.keys(FRAME_MATERIALS), i.frameMaterial)) problems.push(`internals.frameMaterial must be one of: ${list(Object.keys(FRAME_MATERIALS))}.`)
  if (!oneOf(Object.keys(AVIONICS), i.avionics)) problems.push(`internals.avionics must be one of: ${list(Object.keys(AVIONICS))}.`)
  if (!oneOf(Object.keys(PROP_MATERIALS), i.propMaterial)) problems.push(`internals.propMaterial must be one of: ${list(Object.keys(PROP_MATERIALS))}.`)
  if (!num(i.propBlades) || i.propBlades < 2 || i.propBlades > 6) problems.push('internals.propBlades must be a number from 2 to 6.')
  const bat = i.battery
  if (!oneOf(Object.keys(CHEMISTRY), bat.chemistry)) problems.push(`internals.battery.chemistry must be one of: ${list(Object.keys(CHEMISTRY))}.`)
  if (!num(bat.cells) || bat.cells < 1 || bat.cells > 24) problems.push('internals.battery.cells must be a number from 1 to 24.')
  if (!num(bat.capacityMah) || bat.capacityMah < 50 || bat.capacityMah > 200000) problems.push('internals.battery.capacityMah must be a number from 50 to 200000.')
  if (!num(bat.position) || bat.position < -1 || bat.position > 1) problems.push('internals.battery.position must be a number from -1 (aft) to 1 (forward).')
  for (const k of ['primary', 'secondary', 'accent'] as const) if (typeof spec.livery[k] !== 'string' || !HEX.test(spec.livery[k])) problems.push(`livery.${k} must be a hex colour like "#ff6a2b".`)
  if (!oneOf(['matte', 'satin', 'gloss'], spec.livery.finish)) problems.push('livery.finish must be matte, satin or gloss.')
  if (!oneOf(['solid', 'split', 'stripe', 'digital', 'hazard'], spec.livery.pattern)) problems.push('livery.pattern must be solid, split, stripe, digital or hazard.')
  checkLoadout(spec.weapons, 'weapons', problems)
  checkLoadout(spec.systems, 'systems', problems)
  if (!problems.length) {
    const mounts = [...spec.weapons, ...spec.systems].filter(m => m.id !== 'stealth').map(m => m.mount)
    if (mounts.length !== new Set(mounts).size) problems.push('Two modules share a mount. Each mount holds one module (the stealth skin is the exception).')
  }
  if (problems.length) throw new SpecError(problems)

  // The physics must produce real numbers, or the simulator would start with NaN in its state.
  try {
    const p = computePerformance(spec)
    if (![p.massKg, p.speed.max, p.endurance.bestMin, p.thrust.twr].every(Number.isFinite)) throw new Error('non-finite result')
    if (!p.flightReady) warnings.push(`Not flight-ready: ${p.advice[0] ?? 'the model reports a failing check.'}`)
  } catch {
    throw new SpecError(['The physics model could not evaluate this drone. Check the sizes, battery and motor.'])
  }
  return { spec, warnings, kind: 'spec' }
}

/** Turns a short recipe into a full, flight-sized spec. */
export function buildFromRecipe(r: unknown): LoadedDrone {
  const problems: string[] = []
  if (!isObj(r)) throw new SpecError(['A recipe must be a JSON object.'])
  if (r.format !== undefined && r.format !== RECIPE_FORMAT) problems.push(`format is ${JSON.stringify(r.format)}; expected "${RECIPE_FORMAT}" (or leave it out).`)
  if (!oneOf(LAYOUT_IDS, r.layout)) problems.push(`layout "${String(r.layout)}" is not known. Choose one of: ${list(LAYOUT_IDS)}.`)
  checkSize(r.length, r.width ?? r.length, problems, '')
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : ''
  if (!name) problems.push('name is required.')
  if (problems.length) throw new SpecError(problems)

  const layout = r.layout as LayoutId
  const L = r.length as number
  const W = (r.width ?? r.length) as number
  const taken = new Set<string>()
  const expand = (items: unknown, defs: readonly ModuleDef<string>[], kind: 'weapons' | 'systems') => {
    if (items === undefined) return []
    if (!Array.isArray(items)) { problems.push(`${kind} must be a list.`); return [] }
    return items.map((it, idx) => {
      const id = typeof it === 'string' ? it : isObj(it) ? String(it.id) : ''
      const def = defs.find(d => d.id === id)
      if (!def) { problems.push(`${kind}[${idx}] "${id}" is not known. Choose one of: ${list(defs.map(d => d.id))}.`); return { id, mount: 'belly' as Mount } }
      let mount = isObj(it) ? (it.mount as Mount | undefined) : undefined
      if (mount === undefined) mount = def.mounts.find(m => def.id === 'stealth' || !taken.has(m)) ?? def.mounts[0]
      if (def.id !== 'stealth') taken.add(mount)
      return { id: def.id, mount }
    })
  }
  const weapons = expand(r.weapons, WEAPONS, 'weapons')
  const systems = expand(r.systems, SYSTEMS, 'systems')
  if (problems.length) throw new SpecError(problems)

  const spec0 = defaultSpec(layout, L, W, name)
  const spec1: DroneSpec = {
    ...spec0,
    weapons, systems,
    body: { ...spec0.body, ...(isObj(r.body) ? r.body : {}) },
    livery: { ...spec0.livery, ...(isObj(r.livery) ? r.livery : {}) },
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 500) : undefined,
    internals: {
      ...spec0.internals,
      ...(r.avionics ? { avionics: r.avionics as AvionicsTier } : {}),
      ...(r.frameMaterial ? { frameMaterial: r.frameMaterial as FrameMaterial } : {}),
      ...(r.propMaterial ? { propMaterial: r.propMaterial as PropMaterial } : {}),
      battery: { ...spec0.internals.battery, ...(r.chemistry ? { chemistry: r.chemistry as Chemistry } : {}) },
    },
  }
  // Validate what the recipe asked for before sizing around it.
  const checked = validateSpec(spec1)
  // Loadouts are heavy: size motors and battery around them, then balance the centre of gravity.
  const spec = sizeUp(checked.spec, r.chemistry === undefined)
  const warnings = [...checked.warnings.filter(w => !w.startsWith('Not flight-ready')), ...flightWarning(spec)]
  return { spec, warnings, kind: 'recipe' }
}

/**
 * Same steps as the designer's "new design": pick motors and cells, size the pack, and slide it to
 * balance. Li-ion can't always feed a hot multirotor, so unless the recipe chose a chemistry we fall
 * back to LiPo when the power check fails.
 */
function sizeUp(spec: DroneSpec, mayChangeChemistry: boolean): DroneSpec {
  let s = sizeBattery(sizePropulsion(spec))
  const powerFails = computePerformance(s).checks.find(c => c.id === 'power')?.status === 'fail'
  if (mayChangeChemistry && powerFails && s.internals.battery.chemistry !== 'lipo') {
    s = sizeBattery(sizePropulsion({ ...s, internals: { ...s.internals, battery: { ...s.internals.battery, chemistry: 'lipo' } } }))
  }
  return autoBalance(s)
}

function flightWarning(spec: DroneSpec): string[] {
  const p = computePerformance(spec)
  return p.flightReady ? [] : [`Not flight-ready: ${p.advice[0] ?? 'the model reports a failing check.'}`]
}

/** Reads any supported drone JSON (text or parsed). */
export function loadDrone(input: unknown): LoadedDrone {
  const o = typeof input === 'string' ? parseJson(input) : input
  if (!isObj(o)) throw new SpecError(['This JSON is not a drone. Expected an object.'])
  if (o.format === SPEC_FORMAT && isObj(o.spec)) return validateSpec(o.spec)
  // No version and no envelope, but a layout or length: it is meant as a recipe, so report recipe problems.
  if (o.format === RECIPE_FORMAT || (o.version === undefined && o.envelope === undefined && ('layout' in o || 'length' in o))) return buildFromRecipe(o)
  if (o.version === 3 || isObj(o.envelope)) return validateSpec(o)
  throw new SpecError([`This JSON is not a drone file. Expected a "${SPEC_FORMAT}" export, a bare spec ("version": 3), or a recipe ("format": "${RECIPE_FORMAT}").`])
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch (e) { throw new SpecError([`Not valid JSON: ${(e as Error).message}`]) }
}

/** The file format written by the CLI and the "Download" button. Compatible with Drone Surrogate Factory. */
export function droneFile(spec: DroneSpec): string {
  const p = computePerformance(spec)
  return JSON.stringify({
    format: SPEC_FORMAT,
    spec,
    summary: {
      className: p.className, massKg: +p.massKg.toFixed(4), maxSpeedMs: +p.speed.max.toFixed(2), enduranceMin: +p.endurance.bestMin.toFixed(1),
      thrustToWeight: +p.thrust.twr.toFixed(3), flightReady: p.flightReady,
    },
  }, null, 2) + '\n'
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'drone'

export { weaponById, systemById }
