/**
 * Anchor points of an airframe — rotor stations, hardpoints, battery, lift centre — computed
 * analytically WITHOUT building meshes. The performance model runs this on every slider move
 * and on every hover preview, so it has to be cheap. buildGeometry() uses the same function for
 * its hardpoints, so the CG the designer reports and the mesh it shows cannot disagree.
 *
 * Positions are in the pre-centring frame (body centre at the origin). Balance checks only use
 * differences between points, which centring does not change.
 */
import * as THREE from 'three'
import type { DroneSpec, Mount } from './types'
import { LAYOUTS, solveStations, type Station } from './layouts'
import { resolveShape, type Shape } from './shape'
import { batteryDims } from './battery'

export const MODULE_HEIGHT: Record<string, number> = {
  kinetic: 0.11, bomb: 0.11, net: 0.11, missile: 0.09, laser: 0.1, emp: 0.14,
  radar: 0.12, lidar: 0.077, thermal: 0.135, carrier: 0.115, searchlight: 0.12, smoke: 0.09,
  winch: 0.21, parachute: 0.125, stealth: 0,
}

export interface WingNumbers { mac: number; area: number; qcX: number; span: number; aspect: number }

export function wingNumbers(S: Shape): WingNumbers {
  const bl = S.bodyL
  const half = S.W / 2
  const cr = Math.max(S.wingRoot, 1e-4), ct = Math.max(S.wingTip, 1e-4)
  const x0 = bl * 0.02
  const lam = ct / cr
  const mac = (2 / 3) * cr * ((1 + lam + lam * lam) / (1 + lam))
  const area = S.W * (cr + ct) / 2
  const f = ((1 + 2 * lam) / (1 + lam)) / 3
  const le = x0 + (cr + (ct - cr) * f) / 2 - S.wingSweep * f
  void half
  return { mac, area, qcX: le - mac / 4, span: S.W, aspect: (S.W * S.W) / Math.max(area, 1e-6) }
}

export interface LayoutPoints {
  S: Shape
  stations: Station[]
  feasible: boolean
  residual: number
  thrustCenter: THREE.Vector3
  bodyCenter: THREE.Vector3
  batteryCenter: THREE.Vector3
  hardpoints: Record<Mount, THREE.Vector3>
  modules: { id: string; kind: 'weapon' | 'system'; mount: Mount; center: THREE.Vector3 }[]
  wing: WingNumbers | null
  /** Aeroplanes: neutral point estimate (wing quarter-chord moved aft by the tail). */
  neutralPointX: number | null
  tailX: number
}

export function layoutPoints(spec: DroneSpec, shapeOverride?: Partial<Shape>): LayoutPoints {
  const S = resolveShape(spec, shapeOverride)
  const lay = LAYOUTS[spec.layout]
  const { L, W } = S
  const bl = S.bodyL, bw = S.bodyW, bh = S.bodyH
  const wingish = lay.kind === 'wing' || lay.kind === 'wing_ring'

  let bodyCenter = new THREE.Vector3()
  const thrustCenter = new THREE.Vector3()
  let stations: Station[] = []
  let feasible = true, residual = 0
  let wing: WingNumbers | null = null
  let neutralPointX: number | null = null

  if (lay.kind === 'heli') {
    const rr = W / 2
    const mastX = L / 2 - rr
    bodyCenter = new THREE.Vector3(mastX + bl * 0.06, 0, 0)
    thrustCenter.set(mastX, 0, bh * 0.95)
  } else {
    if (wingish) {
      wing = wingNumbers(S)
      thrustCenter.set(wing.qcX, 0, bh * 0.1)
      neutralPointX = wing.qcX - 0.25 * wing.mac * Math.min(S.tailScale, 1.6) * (spec.body.tail === 'none' ? 0 : 1)
    }
    if (lay.kind !== 'wing') {
      const sol = solveStations(spec.layout, L, W, S.propD)
      stations = sol.stations
      feasible = sol.feasible
      residual = sol.residual
      if (stations.length) {
        thrustCenter.set(
          stations.reduce((a, s) => a + s.x, 0) / stations.length,
          stations.reduce((a, s) => a + s.y, 0) / stations.length,
          bh * 0.06,
        )
      }
    }
  }

  const bd = batteryDims(spec)
  const batteryTop = lay.kind === 'wing' || lay.kind === 'heli' ? 0 : bd.z
  const cx = bodyCenter.x
  const bx = spec.internals.battery.position * bl * 0.32
  const batteryCenter = lay.kind === 'wing'
    ? new THREE.Vector3(bx + bl * 0.05, 0, 0)
    : new THREE.Vector3(cx + bx, 0, bh / 2 + bd.z / 2)

  const hardpoints: Record<Mount, THREE.Vector3> = {
    belly: new THREE.Vector3(cx, 0, -bh / 2),
    nose: new THREE.Vector3(cx + bl * 0.4, 0, -bh * 0.42),
    top: new THREE.Vector3(cx - bl * 0.12, 0, bh / 2 + batteryTop * 0.9),
    tail: new THREE.Vector3(cx - bl * 0.42, 0, -bh * 0.4),
    left: wingish ? new THREE.Vector3(bl * 0.02, W * 0.22, bh * 0.1 - S.wingThick * 0.5)
      : new THREE.Vector3(cx, bw / 2 + Math.max(0.05, bw * 0.45), -bh * 0.2),
    right: wingish ? new THREE.Vector3(bl * 0.02, -W * 0.22, bh * 0.1 - S.wingThick * 0.5)
      : new THREE.Vector3(cx, -(bw / 2 + Math.max(0.05, bw * 0.45)), -bh * 0.2),
  }

  const modules = [
    ...spec.weapons.map(m => ({ ...m, kind: 'weapon' as const })),
    ...spec.systems.map(m => ({ ...m, kind: 'system' as const })),
  ].filter(m => m.id !== 'stealth').map(m => {
    const hp = hardpoints[m.mount].clone()
    const h = MODULE_HEIGHT[m.id] ?? 0.1
    hp.z += m.mount === 'top' ? h / 2 : -h / 2
    return { id: m.id, kind: m.kind, mount: m.mount, center: hp }
  })

  return {
    S, stations, feasible, residual, thrustCenter, bodyCenter, batteryCenter, hardpoints, modules,
    wing, neutralPointX, tailX: cx - bl * 0.44,
  }
}
