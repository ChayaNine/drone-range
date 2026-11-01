/**
 * Flight physics. The craft is driven by the SAME numbers the designer shows: thrust, mass, drag
 * areas, tilt limit, response time, stall speed and power draw all come from computePerformance.
 * So a drone that the designer says tops out at 17 m/s tops out at about 17 m/s here.
 *
 * World is Y-up (x east, z south). Body frame: +X forward, +Y up, +Z right.
 * Multirotors and helicopters fly an assisted angle-mode controller (stick = desired velocity,
 * or stick = tilt with assist off). Aeroplanes fly an energy-based model: thrust and drag set the
 * speed, the nose sets the path, and below stall speed the wing stops holding you up.
 */
import * as THREE from 'three'
import type { Performance } from '../engine/performance'
import { G, RHO } from '../engine/performance'
import { groundAt, insideSolid, type World } from './world'

export interface Input { pitch: number; roll: number; yaw: number; throttle: number }

export interface CraftParams {
  kind: 'multirotor' | 'wing' | 'vtol' | 'heli'
  mass: number
  Tmax: number
  tiltMax: number
  tau: number
  yawRate: number
  climbMax: number
  vmax: number
  Afront: number
  Atop: number
  stall: number
  wingArea: number
  Cd0: number
  k: number
  vPitch: number
  T0: number
  hoverW: number
  cruiseW: number
  auxW: number
  energyWh: number
  hp: number
  radius: number
}

export function craftParams(perf: Performance, size: THREE.Vector3): CraftParams {
  const kind = perf.kind === 'wing' ? 'wing' : perf.kind === 'wing_ring' ? 'vtol' : perf.kind === 'heli' ? 'heli' : 'multirotor'
  return {
    kind,
    mass: perf.massKg,
    Tmax: perf.thrust.totalN,
    tiltMax: Math.max(perf.aero.tiltMax, 0.15),
    tau: perf.agility.tau,
    yawRate: (Math.max(perf.agility.yawRate, 40) * Math.PI) / 180,
    climbMax: Math.max(perf.speed.climb, 1.5),
    vmax: perf.speed.max,
    Afront: Math.max(perf.aero.Afront, 1e-4),
    Atop: Math.max(perf.aero.Atop, 1e-4),
    stall: perf.speed.stall ?? 0,
    wingArea: perf.aero.wingArea,
    Cd0: perf.aero.Cd0,
    k: perf.aero.k,
    vPitch: perf.aero.vPitch,
    T0: perf.aero.staticThrustN || perf.thrust.totalN,
    hoverW: perf.power.hoverW,
    cruiseW: perf.power.cruiseW,
    auxW: perf.power.auxW,
    energyWh: perf.power.usableWh,
    hp: perf.durabilityHp,
    radius: Math.max(size.x, size.y) * 0.5,
  }
}

const Y = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion(), _e = new THREE.Euler()

export class Craft {
  p: CraftParams
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  // multirotor attitude
  yaw = 0
  pitch = 0
  roll = 0
  // aeroplane state
  quat = new THREE.Quaternion()
  airspeed = 0
  sink = 0
  throttle = 0.6
  mode: 'hover' | 'cruise' = 'hover'
  assist = true
  energyWh: number
  hp: number
  extraMass = 0
  thrustN = 0
  powerW = 0
  alive = true
  landed = true
  chuted = false
  lastImpact = 0
  odometer = 0
  maxSpeed = 0
  private t = 0

  constructor(p: CraftParams, spawn: THREE.Vector3, yaw: number, launched = false) {
    this.p = p
    this.energyWh = p.energyWh
    this.hp = p.hp
    this.pos.copy(spawn)
    this.yaw = yaw
    if (p.kind === 'wing') {
      // Aeroplanes are launched (catapult / hand launch) at a safe speed and height.
      this.mode = 'cruise'
      this.pos.y += 30
      this.airspeed = Math.max(p.stall * 1.45, 10)
      this.quat.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'))
      this.landed = false
      this.throttle = 0.7
    } else {
      this.pos.y += p.radius * 0.35 + 0.05
      this.landed = !launched
    }
  }

  get mass() { return this.p.mass + this.extraMass }
  get battery() { return Math.max(0, this.energyWh / Math.max(this.p.energyWh, 1e-6)) }
  get speed() { return this.vel.length() }

  orientation(out = new THREE.Quaternion()): THREE.Quaternion {
    if (this.mode === 'cruise') return out.copy(this.quat)
    _e.set(0, this.yaw, 0, 'YXZ')
    out.setFromEuler(_e)
    const qp = _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.pitch)
    out.multiply(qp)
    out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.roll))
    return out
  }
  forward(out = new THREE.Vector3()) { return out.set(1, 0, 0).applyQuaternion(this.orientation()) }
  up(out = new THREE.Vector3()) { return out.set(0, 1, 0).applyQuaternion(this.orientation()) }
  heading() { const f = this.forward(); return ((Math.atan2(f.x, -f.z) * 180) / Math.PI + 360) % 360 }

  windAt(w: World, t: number) {
    const g = w.gust
    return new THREE.Vector3(
      w.wind.x + g * (Math.sin(t * 0.7 + 1) * 0.6 + Math.sin(t * 1.9) * 0.4),
      g * 0.2 * Math.sin(t * 1.3 + 2),
      w.wind.z + g * (Math.cos(t * 0.53) * 0.6 + Math.sin(t * 2.3 + 1) * 0.4),
    )
  }

  /** Switch a VTOL between hover and wing-borne cruise. Returns a message for the HUD. */
  toggleTransition(): string {
    if (this.p.kind !== 'vtol') return ''
    if (this.mode === 'hover') {
      const fwd = this.forward()
      const gs = this.vel.dot(new THREE.Vector3(fwd.x, 0, fwd.z).normalize())
      if (gs < this.p.stall * 0.8) return `Need ${(this.p.stall * 0.8).toFixed(0)} m/s forward speed to transition`
      this.mode = 'cruise'
      this.quat.setFromEuler(new THREE.Euler(0, this.yaw, 0, 'YXZ'))
      this.airspeed = Math.max(gs, this.p.stall * 1.05)
      this.sink = 0
      return 'Wing-borne'
    }
    const f = this.forward()
    this.yaw = Math.atan2(-f.z, f.x)
    this.pitch = 0; this.roll = 0
    this.mode = 'hover'
    return 'Hover mode'
  }

  step(dt: number, inp: Input, w: World, extraPowerW = 0) {
    if (!this.alive) return
    this.t += dt
    const wind = this.windAt(w, this.t)
    const lowBatt = this.energyWh <= 0
    if (this.mode === 'cruise') this.stepWing(dt, inp, w, wind, lowBatt)
    else this.stepRotor(dt, inp, wind, lowBatt)
    this.energyWh = Math.max(0, this.energyWh - ((this.powerW + extraPowerW) * dt) / 3600)
    this.odometer += this.vel.length() * dt
    this.maxSpeed = Math.max(this.maxSpeed, this.vel.length())
    this.collide(w)
  }

  private stepRotor(dt: number, inp: Input, wind: THREE.Vector3, lowBatt: boolean) {
    const p = this.p
    const m = this.mass
    const tiltMax = p.kind === 'heli' ? Math.min(p.tiltMax, 0.52) : p.tiltMax
    const fwd = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const right = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    let pt: number, rt: number
    if (this.assist) {
      // stick → desired ground velocity; controller tilts to get there, within the tilt limit
      const vCmd = p.vmax * 0.98
      const vDes = fwd.clone().multiplyScalar(inp.pitch * vCmd).addScaledVector(right, inp.roll * vCmd)
      const vH = new THREE.Vector3(this.vel.x, 0, this.vel.z)
      const aDes = vDes.sub(vH).multiplyScalar(1.4)
      const aMax = G * Math.tan(tiltMax)
      if (aDes.length() > aMax) aDes.setLength(aMax)
      pt = -Math.atan2(aDes.dot(fwd), G)
      rt = Math.atan2(aDes.dot(right), G)
    } else {
      pt = -inp.pitch * tiltMax
      rt = inp.roll * tiltMax
    }
    pt = THREE.MathUtils.clamp(pt, -tiltMax, tiltMax)
    rt = THREE.MathUtils.clamp(rt, -tiltMax, tiltMax)
    const a = 1 - Math.exp(-dt / Math.max(p.tau, 0.03))
    this.pitch += (pt - this.pitch) * a
    this.roll += (rt - this.roll) * a
    this.yaw -= inp.yaw * p.yawRate * dt

    const up = this.up()
    const vyDes = inp.throttle >= 0 ? inp.throttle * p.climbMax : inp.throttle * p.climbMax * 0.85
    const ay = (vyDes - this.vel.y) * 3.2
    let T = (m * (G + ay)) / Math.max(up.y, 0.2)
    const Tlim = p.Tmax * (lowBatt ? 0.55 : 1)
    if (this.landed && inp.throttle <= 0.05) T = Math.min(T, m * G * 0.6)
    T = THREE.MathUtils.clamp(T, 0, Tlim)
    if (this.chuted) T = 0
    this.thrustN = T

    const air = this.vel.clone().sub(wind)
    const airH = new THREE.Vector3(air.x, 0, air.z)
    const F = up.multiplyScalar(T)
    F.y -= m * G
    F.addScaledVector(airH, -0.5 * RHO * 1.0 * p.Afront * airH.length())
    F.y += -0.5 * RHO * 1.2 * p.Atop * air.y * Math.abs(air.y)
    if (this.chuted) { F.y += 0.5 * RHO * 1.4 * Math.max(4 * p.radius * p.radius, 0.8) * 8 * Math.max(-this.vel.y, 0) ** 2 }
    this.vel.addScaledVector(F, dt / m)
    this.pos.addScaledVector(this.vel, dt)
    // Power: hover power scales with thrust^1.5 (momentum theory)
    const ratio = T / Math.max(this.p.mass * G, 1e-6)
    this.powerW = (p.hoverW - p.auxW) * Math.pow(Math.max(ratio, 0.05), 1.5) + p.auxW
    if (this.landed && T < m * G * 0.95) this.vel.set(0, Math.max(this.vel.y, 0), 0)
    if (T > m * G * 1.02) this.landed = false
  }

  private stepWing(dt: number, inp: Input, w: World, wind: THREE.Vector3, lowBatt: boolean) {
    const p = this.p
    const m = this.mass
    const vs = Math.max(p.stall, 4)
    this.throttle = THREE.MathUtils.clamp(this.throttle + inp.throttle * dt * 0.6, 0, 1)
    if (lowBatt) this.throttle = 0
    const ca = THREE.MathUtils.clamp((this.airspeed / (1.2 * vs)) ** 2, 0.12, 1)
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat)
    const rightB = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat)
    const bank = Math.asin(THREE.MathUtils.clamp(-rightB.y, -1, 1))
    const rollRate = 2.6 / (0.5 + p.tau) * ca
    const pitchRate = 1.2 / (0.5 + p.tau) * ca
    const dq = new THREE.Quaternion()
    // body-axis rates: roll about X, pitch about Z, yaw about Y
    dq.setFromEuler(new THREE.Euler(inp.roll * rollRate * dt, -inp.yaw * 0.5 * ca * dt, -inp.pitch * pitchRate * dt, 'XYZ'))
    this.quat.multiply(dq)
    // coordinated turn: banked lift turns the path
    const turn = (G * Math.tan(THREE.MathUtils.clamp(bank, -1.3, 1.3))) / Math.max(this.airspeed, 5) * Math.min(1, (this.airspeed / vs) ** 2)
    this.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(Y, -turn * dt))
    // stall: the nose falls
    if (this.airspeed < vs) this.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.9 * (1 - this.airspeed / vs) * dt))
    this.quat.normalize()

    const S = Math.max(p.wingArea, 0.05)
    const q = 0.5 * RHO * this.airspeed * this.airspeed
    const n = 1 / Math.max(Math.cos(bank), 0.3)
    const D = q * S * p.Cd0 + ((n * m * G) ** 2) / Math.max(q * S, 1e-3) * p.k
    const T = p.T0 * this.throttle * Math.max(0, 1 - this.airspeed / Math.max(p.vPitch, 5))
    this.thrustN = T
    this.airspeed += ((T - D) / m - G * fwd.y) * dt
    this.airspeed = Math.max(this.airspeed, 0)
    // Below stall the wing cannot carry the weight: a sink rate builds.
    const liftFrac = Math.min(1, (this.airspeed / vs) ** 2)
    this.sink += -G * (1 - liftFrac * Math.cos(bank)) * dt
    this.sink *= Math.exp(-dt * 3 * liftFrac)
    this.vel.copy(fwd).multiplyScalar(this.airspeed).add(wind)
    this.vel.y += this.sink
    this.pos.addScaledVector(this.vel, dt)
    this.powerW = p.cruiseW * (0.35 + 0.65 * this.throttle ** 1.5)
    void w
  }

  /** Ground and obstacle contact. Damage scales with impact energy over durability. */
  private collide(w: World) {
    const r = Math.max(this.p.radius * 0.6, 0.06)
    const g = groundAt(w, this.pos.x, this.pos.z)
    const bottom = this.pos.y - r * 0.5
    if (bottom < g) {
      const vImpact = Math.max(-this.vel.y, 0) + (this.mode === 'cruise' ? this.vel.length() * 0.6 : 0)
      this.pos.y = g + r * 0.5
      if (w.water && g <= 0.01 && vImpact > 0.5) { this.damage(9999, 'water'); return }
      if (vImpact > 2.2 || (this.mode === 'cruise' && this.airspeed > this.p.stall * 1.3)) this.damage(vImpact * vImpact * 6, 'ground')
      this.vel.y = Math.max(this.vel.y, 0)
      this.vel.x *= 0.6; this.vel.z *= 0.6
      if (this.mode === 'cruise') { this.airspeed *= 0.6 }
      if (this.mode === 'hover' && this.thrustN < this.mass * G) this.landed = true
    }
    if (insideSolid(w, this.pos, r * 0.6)) {
      const v = this.vel.length()
      this.damage(v * v * 5 + 4, 'obstacle')
      this.pos.addScaledVector(this.vel, -0.06)
      this.vel.multiplyScalar(-0.35)
      if (this.mode === 'cruise') this.airspeed *= 0.4
    }
    if (Math.abs(this.pos.x) > w.half || Math.abs(this.pos.z) > w.half) {
      this.pos.x = THREE.MathUtils.clamp(this.pos.x, -w.half, w.half)
      this.pos.z = THREE.MathUtils.clamp(this.pos.z, -w.half, w.half)
      this.vel.x *= -0.3; this.vel.z *= -0.3
    }
    if (this.pos.y > 600) { this.pos.y = 600; this.vel.y = Math.min(this.vel.y, 0) }
  }

  onDamage: ((amount: number, cause: string) => void) | null = null
  damage(amount: number, cause: string) {
    if (!this.alive || amount <= 0) return
    if (this.t - this.lastImpact < 0.25 && cause !== 'water') return
    this.lastImpact = this.t
    this.hp -= amount
    this.onDamage?.(amount, cause)
    if (this.hp <= 0) this.alive = false
  }

  agl(w: World) { return this.pos.y - groundAt(w, this.pos.x, this.pos.z) }
}
