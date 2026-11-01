/**
 * Smart defaults: every new design starts flyable and balanced. Picks the motor class and cell
 * count that give a healthy thrust-to-weight on the airframe's own propeller, sizes the pack to
 * a sensible share of takeoff mass, then slides the battery to centre the CG.
 */
import type { Chemistry, DroneSpec, LayoutId } from './types'
import { LAYOUTS } from './layouts'
import { MOTORS, CHEMISTRY, HYDROGEN } from './parts'
import { defaultSpec } from './shape'
import { computePerformance, autoBalance } from './performance'
import { batteryMassKg } from './battery'

const TARGET_TWR: Record<string, number> = { ring: 2.6, wing_ring: 2.3, heli: 2.1, wing: 0.6 }
const BATTERY_SHARE: Record<string, number> = { ring: 0.32, wing_ring: 0.34, heli: 0.3, wing: 0.36 }

/** Capacity (mAh) that makes the pack weigh `kg`. */
export function capacityForMass(spec: DroneSpec, kg: number): number {
  const b = spec.internals.battery
  const chem = CHEMISTRY[b.chemistry]
  const cellKg = Math.max((kg - 0.004 - (b.chemistry === 'hydrogen' ? HYDROGEN.stackKg : 0)) / 1.06, 0.005)
  const wh = cellKg * chem.whPerKg
  const mah = (wh / (b.cells * chem.cellV)) * 1000
  const step = mah > 5000 ? 100 : 50
  return Math.max(150, Math.round(mah / step) * step)
}

/** Re-size the pack so it is `share` of takeoff mass, keeping everything else. */
export function sizeBattery(spec: DroneSpec, share = BATTERY_SHARE[LAYOUTS[spec.layout].kind]): DroneSpec {
  let s = spec
  for (let i = 0; i < 3; i++) {
    const p = computePerformance(s)
    const empty = p.massKg - batteryMassKg(s)
    const target = (share / (1 - share)) * empty
    s = { ...s, internals: { ...s.internals, battery: { ...s.internals.battery, capacityMah: capacityForMass(s, target) } } }
  }
  return s
}

/** Choose motor class and cell count for a healthy thrust-to-weight. */
export function sizePropulsion(spec: DroneSpec): DroneSpec {
  const kind = LAYOUTS[spec.layout].kind
  const target = TARGET_TWR[kind]
  let best: { s: DroneSpec; score: number } | null = null
  for (const m of MOTORS) {
    for (let cells = m.minS; cells <= m.maxS; cells += cells >= 6 ? 2 : 1) {
      let s: DroneSpec = { ...spec, internals: { ...spec.internals, motorId: m.id, battery: { ...spec.internals.battery, cells } } }
      s = sizeBattery(s)
      const p = computePerformance(s)
      const match = p.checks.find(c => c.id === 'match')
      const power = p.checks.find(c => c.id === 'power')
      let score = Math.abs(Math.log(Math.max(p.thrust.twr, 1e-3) / target))
      if (match?.status === 'fail') score += 3
      if (match?.status === 'warn') score += 0.4
      if (power?.status === 'fail') score += 0.8
      if (p.thrust.twr < (kind === 'wing' ? 0.4 : 1.8)) score += 2
      score += p.price.totalUsd / 200000
      if (!best || score < best.score) best = { s, score }
    }
  }
  return best ? best.s : spec
}

/** A complete, flight-ready starting design. */
export function newDesign(layout: LayoutId, L: number, W: number, name = 'New drone', chemistry?: Chemistry): DroneSpec {
  let s = defaultSpec(layout, L, W, name)
  if (chemistry) s = { ...s, internals: { ...s.internals, battery: { ...s.internals.battery, chemistry } } }
  s = sizePropulsion(s)
  s = sizeBattery(s)
  // Li-ion cannot always feed a hot multirotor; fall back to LiPo if the power check fails.
  if (computePerformance(s).checks.find(c => c.id === 'power')?.status === 'fail' && s.internals.battery.chemistry !== 'lipo') {
    s = sizeBattery({ ...s, internals: { ...s.internals, battery: { ...s.internals.battery, chemistry: 'lipo' } } })
  }
  return autoBalance(s)
}
