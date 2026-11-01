/** Battery sizing, kept apart from the performance model so geometry can use it without a cycle. */
import * as THREE from 'three'
import type { DroneSpec } from './types'
import { CHEMISTRY, HYDROGEN } from './parts'

export function packVoltage(spec: DroneSpec): number {
  const b = spec.internals.battery
  return b.cells * CHEMISTRY[b.chemistry].cellV
}

export function packWh(spec: DroneSpec): number {
  const b = spec.internals.battery
  return packVoltage(spec) * (b.capacityMah / 1000)
}

export function batteryMassKg(spec: DroneSpec): number {
  const b = spec.internals.battery
  const chem = CHEMISTRY[b.chemistry]
  const cellMass = packWh(spec) / chem.whPerKg
  // Wiring, BMS and case: 6% plus a few grams.
  const pack = cellMass * 1.06 + 0.004
  return b.chemistry === 'hydrogen' ? pack + HYDROGEN.stackKg : pack
}

/** Pack dimensions from mass (LiPo packs are close to 1.9 kg/L), proportioned 3 : 1.3 : 1. */
export function batteryDims(spec: DroneSpec): THREE.Vector3 {
  const vol = batteryMassKg(spec) / 1900
  const a = Math.cbrt(vol / 3.9)
  return new THREE.Vector3(3 * a, 1.3 * a, a)
}
