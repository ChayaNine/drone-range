/**
 * The mission layer on top of the flight physics: what is in the world, what the weapons and
 * systems do, how points are scored and when a run ends. No rendering here — the Flight page
 * draws whatever this holds, so the game can also be stepped headless in tests.
 *
 * All weapons and systems are fictional, abstract game modules. Their mass, drag and power
 * come from the designer, so carrying them changes how the drone flies.
 */
import * as THREE from 'three'
import type { DroneSpec, Mount } from '../engine/types'
import type { Performance } from '../engine/performance'
import { G } from '../engine/performance'
import type { DroneGeometry } from '../engine/geometry'
import { weaponById, systemById, type ModuleDef, type SystemBehaviour, type WeaponBehaviour } from '../engine/parts'
import { mulberry32 } from '../engine/pointcloud'
import { SENSORS, beamAngles } from '../engine/lidar/sensors'
import { Craft, craftParams, type Input } from './flight'
import { buildWorld, freeSpot, groundAt, insideSolid, raycastWorld, segmentHitsWorld, worldNear, type World } from './world'
import type { EnvDef, MissionDef } from './catalog'

export type EntityKind = 'target' | 'balloon' | 'hostile' | 'rogue' | 'crate' | 'micro'
export type EntityModel = 'truck' | 'board' | 'bunker' | 'balloon' | 'drone' | 'crate' | 'micro'
export type EntityState = 'active' | 'dead' | 'captured' | 'falling' | 'delivered'

export interface Entity {
  id: number
  kind: EntityKind
  model: EntityModel
  pos: THREE.Vector3
  vel: THREE.Vector3
  yaw: number
  radius: number
  hp: number
  maxHp: number
  state: EntityState
  painted: number
  netted: boolean
  disabled: boolean
  value: number
  deadT: number
  color: string
  /** 0..1, how bright it is in thermal. */
  heat: number
  /** Visible to the player right now (line of sight, light, sensors). */
  seen: boolean
  // AI
  home?: THREE.Vector3
  wp?: THREE.Vector3
  speed?: number
  fireCd?: number
  fireRate?: number
  spreadDeg?: number
  standoff?: number
  orbit?: number
  track?: number
  aiT?: number
  path?: THREE.Vector3[]
  pathI?: number
  // crates and micro drones
  mass?: number
  carried?: boolean
  broken?: boolean
  life?: number
  target?: Entity | null
}

export type ProjKind = 'bullet' | 'enemy' | 'bomb' | 'net' | 'missile' | 'pod'
export interface Projectile { kind: ProjKind; pos: THREE.Vector3; prev: THREE.Vector3; vel: THREE.Vector3; age: number; life: number; target: Entity | null; dead: boolean; dmg: number }

export type EffectKind = 'boom' | 'smoke' | 'spark' | 'emp' | 'net' | 'splash' | 'dust' | 'trail' | 'flash'
export interface Effect { kind: EffectKind; pos: THREE.Vector3; age: number; dur: number; size: number; vel?: THREE.Vector3 }

export interface Ring { pos: THREE.Vector3; normal: THREE.Vector3; radius: number; passed: boolean }
export interface Pad { pos: THREE.Vector3; radius: number }
export interface Zone { pos: THREE.Vector3; radius: number; progress: number; done: boolean }
export interface Popup { pos: THREE.Vector3; text: string; age: number; kind: 'good' | 'bad' | 'gold' }
export interface FeedItem { t: number; text: string; kind: 'good' | 'bad' | 'info'; pts?: number }

export interface WeaponSlot {
  def: ModuleDef<WeaponBehaviour>
  mount: Mount
  /** Muzzle in the body frame (Y-up: +X forward, +Y up, +Z right). */
  muzzle: THREE.Vector3
  ammo: number
  maxAmmo: number
  cd: number
  lockT: number
  lockTarget: Entity | null
  firing: boolean
  heldPrev: boolean
}
export interface SystemSlot {
  def: ModuleDef<SystemBehaviour>
  mount: Mount
  active: boolean
  charges: number
  maxCharges: number
  cd: number
}

export type SoundKind = 'shot' | 'enemyShot' | 'boom' | 'net' | 'missile' | 'emp' | 'ring' | 'hit' | 'hurt' | 'pickup' | 'drop' | 'deliver' | 'capture' | 'lock' | 'warn' | 'chute' | 'launch' | 'smoke' | 'wave' | 'zone' | 'empty' | 'laser'

export interface GameOptions {
  spec: DroneSpec
  perf: Performance
  geo: DroneGeometry
  env: EnvDef
  mission: MissionDef
  seed?: number
  wind?: number
  battery?: number
  night?: boolean
  fog?: number
}

export interface RunResult {
  reason: 'complete' | 'time' | 'destroyed' | 'battery' | 'quit'
  completed: boolean
  score: number
  stars: number
  timeMs: number
  breakdown: [string, number][]
  stats: RunStats
}
export interface RunStats {
  shots: number; hits: number; kills: number; captures: number; deliveries: number; rings: number; zones: number
  damageTaken: number; wave: number; distance: number; maxSpeed: number; airtime: number
}

const DEG = Math.PI / 180
const clamp = THREE.MathUtils.clamp
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion()

/** Engine Z-up (x fwd, y left, z up) → simulator body Y-up (x fwd, y up, z right). */
export const zUpToBody = (p: THREE.Vector3) => new THREE.Vector3(p.x, p.z, -p.y)

/** Fraction along a→b where the segment first enters the sphere, or -1. */
function segSphere(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const fx = a.x - c.x, fy = a.y - c.y, fz = a.z - c.z
  const A = dx * dx + dy * dy + dz * dz
  if (A < 1e-12) return fx * fx + fy * fy + fz * fz < r * r ? 0 : -1
  const B = (fx * dx + fy * dy + fz * dz) / A
  const C = (fx * fx + fy * fy + fz * fz - r * r) / A
  const disc = B * B - C
  if (disc < 0) return -1
  const t = -B - Math.sqrt(disc)
  if (t > 1) return -1
  if (t < 0) return C <= 0 ? 0 : -1
  return t
}

function randCone(dir: THREE.Vector3, sigmaRad: number, rnd: () => number, out: THREE.Vector3) {
  // Gaussian cone via two orthogonal offsets
  const a = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(dir, a).normalize()
  const v = new THREE.Vector3().crossVectors(dir, u)
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd())
  return out.copy(dir).addScaledVector(u, g() * sigmaRad).addScaledVector(v, g() * sigmaRad).normalize()
}

export class Game {
  readonly opts: GameOptions
  readonly world: World
  readonly craft: Craft
  readonly spec: DroneSpec
  readonly perf: Performance
  readonly mission: MissionDef
  readonly env: EnvDef
  readonly night: boolean
  readonly span: number
  readonly rnd: () => number

  t = 0
  countdown = 3
  score = 0
  over = false
  result: RunResult | null = null
  paused = false

  entities: Entity[] = []
  projectiles: Projectile[] = []
  effects: Effect[] = []
  rings: Ring[] = []
  pads: Pad[] = []
  zones: Zone[] = []
  popups: Popup[] = []
  feed: FeedItem[] = []
  smoke: { pos: THREE.Vector3; r: number; until: number }[] = []
  nextRing = 0
  version = 0

  weapons: WeaponSlot[] = []
  systems: SystemSlot[] = []
  aim = { origin: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), point: new THREE.Vector3(), dist: 800, entity: null as Entity | null, worldHit: false }
  /** Gimbal / camera pitch in radians; the reticle and every weapon aim along it. */
  aimPitch: number
  laser = { on: false, from: new THREE.Vector3(), to: new THREE.Vector3() }

  carried: Entity | null = null
  cable = 0
  pods = 0
  readonly hookReach: number
  readonly hasWinch: boolean
  chuteReady: boolean
  hurtT = -10
  flash: { text: string; t: number; kind: 'good' | 'bad' | 'info' } | null = null
  wave = 0
  private waveT = 0
  private breakdown = new Map<string, number>()
  stats: RunStats = { shots: 0, hits: 0, kills: 0, captures: 0, deliveries: 0, rings: 0, zones: 0, damageTaken: 0, wave: 0, distance: 0, maxSpeed: 0, airtime: 0 }
  onSound: ((k: SoundKind, pos?: THREE.Vector3, gain?: number) => void) | null = null

  // live LiDAR
  lidar: { on: boolean; pts: Float32Array; col: Float32Array; head: number; count: number; k: number; near: World | null; nearAt: THREE.Vector3; contacts: number; decim: number; rays: number; mountPitch: number } | null = null

  private nextId = 1
  private aiClock = 0
  private visClock = 0
  private aimClock = 0
  private warnClock = 0
  private landedT = 0

  constructor(opts: GameOptions) {
    this.opts = opts
    this.spec = opts.spec
    this.perf = opts.perf
    this.mission = opts.mission
    this.env = opts.env
    this.night = !!(opts.night ?? opts.env.night)
    const seed = opts.seed ?? 7
    this.rnd = mulberry32(seed * 31 + 5)
    this.world = buildWorld(opts.env, seed, opts.wind)
    const size = opts.geo.size
    this.span = Math.max(size.x, size.y)
    this.craft = new Craft(craftParams(opts.perf, new THREE.Vector3(size.x, size.y, size.z)), this.world.spawn, this.world.spawnYaw)
    if (opts.battery != null) this.craft.energyWh *= opts.battery
    this.aimPitch = this.craft.p.kind === 'wing' ? -4 * DEG : -10 * DEG
    this.craft.onDamage = (amt, cause) => this.onCraftDamage(amt, cause)

    // Loadout from the design
    const muzzleFor = (id: string, kind: 'weapon' | 'system', mount: Mount) => {
      const m = opts.geo.modules.find(x => x.id === id && x.kind === kind && x.mount === mount) ?? opts.geo.modules.find(x => x.id === id)
      return m ? zUpToBody(m.muzzle) : new THREE.Vector3(this.span * 0.3, -0.05, 0)
    }
    for (const w of opts.spec.weapons) {
      const def = weaponById(w.id)
      if (!def) continue
      const a = def.stats.ammo
      const ammo = typeof a === 'number' ? a : Infinity
      this.weapons.push({ def, mount: w.mount, muzzle: muzzleFor(w.id, 'weapon', w.mount), ammo, maxAmmo: ammo, cd: 0, lockT: 0, lockTarget: null, firing: false, heldPrev: false })
    }
    for (const s of opts.spec.systems) {
      const def = systemById(s.id)
      if (!def) continue
      const charges = s.id === 'smoke' ? 6 : s.id === 'carrier' ? 3 : s.id === 'parachute' ? 1 : Infinity
      const active = s.id === 'radar' || s.id === 'lidar' || s.id === 'stealth' || s.id === 'winch' || s.id === 'parachute' || (s.id === 'searchlight' && this.night)
      this.systems.push({ def, mount: s.mount, active, charges, maxCharges: charges, cd: 0 })
    }
    this.hasWinch = this.has('winch')
    this.hookReach = this.hasWinch ? 15 : 2.5
    this.chuteReady = this.has('parachute')
    if (this.has('lidar')) {
      const N = 42000
      const sys = this.systems.find(s => s.def.id === 'lidar')!
      this.lidar = {
        on: true, pts: new Float32Array(N * 3), col: new Float32Array(N * 3), head: 0, count: 0, k: 0, near: null, nearAt: new THREE.Vector3(1e9, 0, 0),
        contacts: 0, decim: 10, rays: 400, mountPitch: sys.mount === 'belly' ? -40 * DEG : -8 * DEG,
      }
    }
    this.setupMission()
  }

  has(id: string) { return this.systems.some(s => s.def.id === id) }
  sysOn(id: string) { return this.systems.some(s => s.def.id === id && s.active) }
  get timeLeft() { return this.mission.timeLimit > 0 ? Math.max(0, this.mission.timeLimit - this.t) : Infinity }
  get stealthFactor() { return this.has('stealth') ? 0.45 : 1 }

  // ─────────────────────────────── setup ───────────────────────────────

  private spawnEntity(e: Partial<Entity> & Pick<Entity, 'kind' | 'model' | 'pos'>): Entity {
    const ent: Entity = {
      id: this.nextId++, vel: new THREE.Vector3(), yaw: this.rnd() * Math.PI * 2, radius: 1, hp: 10, maxHp: 10, state: 'active', painted: 0, netted: false,
      disabled: false, value: 100, deadT: 0, color: '#c0392b', heat: 0.6, seen: false, ...e,
    }
    ent.maxHp = ent.hp
    this.entities.push(ent)
    this.version++
    return ent
  }

  private setupMission() {
    const w = this.world, rnd = this.rnd
    const sx = w.spawn.x, sz = w.spawn.z
    const id = this.mission.id
    const vmax = Math.max(this.craft.p.vmax, 6)
    const isWing = this.craft.p.kind === 'wing'
    const far = isWing ? 1.6 : 1

    if (id === 'rings') this.setupRings()

    if (id === 'targets' || (id === 'free' && this.weapons.length)) {
      const nTruck = id === 'free' ? 3 : 8, nBunker = id === 'free' ? 1 : 4, nBall = id === 'free' ? 8 : 8
      for (let i = 0; i < nTruck; i++) {
        const p = freeSpot(w, rnd, sx, sz, 70 * far, 360 * far, 0, 3.5)
        const moving = i % 2 === 0
        const path = moving ? [p.clone(), ...[0, 1, 2].map(() => freeSpot(w, rnd, p.x, p.z, 25, 70, 0, 3))] : undefined
        this.spawnEntity({ kind: 'target', model: 'truck', pos: p, radius: 2.6, hp: 40, value: 100, color: '#6b7a4a', heat: 0.9, path, pathI: 0, speed: moving ? 4 + rnd() * 4 : 0 })
      }
      for (let i = 0; i < nBunker; i++) {
        const p = freeSpot(w, rnd, sx, sz, 120 * far, 420 * far, 0, 5)
        this.spawnEntity({ kind: 'target', model: 'bunker', pos: p, radius: 3.6, hp: 90, value: 150, color: '#8d8a80', heat: 0.35 })
      }
      for (let i = 0; i < nBall; i++) {
        const p = freeSpot(w, rnd, sx, sz, 50 * far, 320 * far, 12 + rnd() * 28, 3, false)
        this.spawnEntity({ kind: 'balloon', model: 'balloon', pos: p, home: p.clone(), radius: 1.1, hp: 8, value: 80, color: ['#e74c3c', '#f1c40f', '#ecf0f1'][i % 3], heat: 0.1 })
      }
    }

    if (id === 'intercept') {
      for (let i = 0; i < 10; i++) {
        const p = freeSpot(w, rnd, sx, sz, 120 * far, 480 * far, 20 + rnd() * 50, 4, false)
        this.spawnEntity({
          kind: 'rogue', model: 'drone', pos: p, home: p.clone(), wp: p.clone(), radius: 0.45, hp: 20, value: 150, color: '#f1c40f', heat: 0.8,
          speed: clamp(vmax * (0.45 + rnd() * 0.25), 5, 32), aiT: rnd(),
        })
      }
    }

    if (id === 'survival') this.waveT = 2

    if (id === 'delivery') {
      if (isWing) {
        this.pods = 5
        for (let i = 0; i < 3; i++) this.pads.push({ pos: freeSpot(w, rnd, sx, sz, 220, 520, 0, 8), radius: 14 })
      } else {
        const lift = Math.max(this.craft.p.Tmax / G * 0.82 - this.craft.p.mass, 0.05)
        const fr = [0.2, 0.35, 0.5, 0.7, 0.95]
        fr.forEach((f, i) => {
          const p = freeSpot(w, rnd, sx, sz, 30, 170, 0, 2.5)
          const mass = Math.max(0.03, lift * f)
          const s = clamp(Math.cbrt(mass / 120), 0.12, 1.2) // crate edge from mass at ~120 kg/m³ packaging
          p.y += s / 2
          this.spawnEntity({ kind: 'crate', model: 'crate', pos: p, radius: s / 2, hp: 1, value: 0, mass, color: '#c8a165', heat: 0.05, yaw: i })
        })
        for (let i = 0; i < 3; i++) this.pads.push({ pos: freeSpot(w, rnd, sx, sz, 150, 330, 0, 6), radius: Math.max(4, this.span * 3) })
      }
    }

    if (id === 'recon') {
      for (let i = 0; i < 5; i++) {
        const p = freeSpot(w, rnd, sx, sz, 120 * far, 460 * far, 0, 3)
        this.zones.push({ pos: p, radius: isWing ? 45 : 24, progress: 0, done: false })
      }
    }
  }

  private setupRings() {
    const w = this.world, rnd = this.rnd
    const isWing = this.craft.p.kind === 'wing'
    const R = isWing ? clamp(this.span * 3.5, 7, 20) : clamp(this.span * 3, 2.5, 10)
    const spacing = clamp(6 * Math.pow(Math.max(this.craft.p.vmax, 5), 0.75), 30, 140) * (isWing ? 1.4 : 1)
    const maxTurn = (isWing ? 32 : 65) * DEG
    if ((this.env.id === 'city' || this.env.id === 'night') && !isWing) return this.streetCourse(R)
    let heading = this.world.spawnYaw
    let prev = w.spawn.clone()
    prev.y = groundAt(w, prev.x, prev.z) + (isWing ? 30 : 4)
    let alt = isWing ? 32 : 14
    for (let i = 0; i < 12; i++) {
      let placed: THREE.Vector3 | null = null
      for (let tries = 0; tries < 90 && !placed; tries++) {
        // widen the search as tries fail: first gentle turns, then any heading, then higher
        const spread = tries < 30 ? maxTurn : tries < 60 ? Math.PI : Math.PI
        const h = heading + (i === 0 && tries < 10 ? 0 : (rnd() - 0.5) * 2 * spread)
        const a = clamp(alt + (rnd() - 0.5) * 22 + Math.max(0, tries - 50) * 3, isWing ? 22 : 7, isWing ? 220 : 170)
        const d = spacing * (i === 0 ? 0.8 : 0.85 + rnd() * 0.3)
        const c = new THREE.Vector3(prev.x + Math.cos(h) * d, 0, prev.z - Math.sin(h) * d)
        if (Math.abs(c.x) > w.half - 60 || Math.abs(c.z) > w.half - 60) { heading += Math.PI / 3; continue }
        c.y = groundAt(w, c.x, c.z) + a
        if (insideSolid(w, c, R + 2)) continue
        if (!this.pathClear(prev, c, Math.max(R * 0.6, 2))) continue
        placed = c; heading = h; alt = a
      }
      if (!placed) { placed = prev.clone().add(new THREE.Vector3(Math.cos(heading) * spacing, 30, -Math.sin(heading) * spacing)); alt += 30 }
      const normal = placed.clone().sub(prev).normalize()
      this.rings.push({ pos: placed, normal, radius: R, passed: false })
      prev = placed
    }
  }

  /** City racing: a random walk along the street grid, ring at every 40 m node, never through a block. */
  private streetCourse(R: number) {
    const rnd = this.rnd
    const onNS = (x: number) => (((x - 40) % 80) + 80) % 80 === 0
    const onEW = (z: number) => (((z - 40) % 80) + 80) % 80 === 0
    let x = 40, z = 0, dir: [number, number] = [1, 0]
    let alt = 12
    const seen = new Set<string>()
    const pts: { x: number; z: number; d: [number, number] }[] = [{ x, z, d: dir }]
    seen.add(`${x},${z}`)
    dir = rnd() < 0.5 ? [0, 1] : [0, -1]
    while (pts.length < 12) {
      const opts: [number, number][] = []
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        if (d[0] === -dir[0] && d[1] === -dir[1]) continue
        if (d[0] !== 0 && !onEW(z)) continue
        if (d[1] !== 0 && !onNS(x)) continue
        const nx = x + d[0] * 40, nz = z + d[1] * 40
        if (Math.abs(nx) > 440 || Math.abs(nz) > 440 || seen.has(`${nx},${nz}`)) continue
        // keep going straight more often than turning: it reads as a course, not a maze
        const wgt = d[0] === dir[0] && d[1] === dir[1] ? 2 : 1
        for (let k = 0; k < wgt; k++) opts.push(d)
      }
      if (!opts.length) break
      dir = opts[Math.floor(rnd() * opts.length)]
      x += dir[0] * 40; z += dir[1] * 40
      seen.add(`${x},${z}`)
      pts.push({ x, z, d: dir })
    }
    for (const p of pts) {
      alt = clamp(alt + (rnd() - 0.5) * 16, 7, 32)
      const pos = new THREE.Vector3(p.x, groundAt(this.world, p.x, p.z) + alt, p.z)
      this.rings.push({ pos, normal: new THREE.Vector3(p.d[0], 0, p.d[1]), radius: R, passed: false })
    }
  }

  /** A fat line test: a pilot needs room around the straight path, not just a clear ray. */
  private pathClear(a: THREE.Vector3, b: THREE.Vector3, margin: number) {
    if (segmentHitsWorld(this.world, a, b)) return false
    const n = Math.ceil(a.distanceTo(b) / 3)
    const p = new THREE.Vector3()
    for (let i = 1; i < n; i++) {
      p.lerpVectors(a, b, i / n)
      if (insideSolid(this.world, p, margin) || p.y - groundAt(this.world, p.x, p.z) < 3) return false
    }
    return true
  }

  private spawnWave(n: number) {
    const w = this.world, rnd = this.rnd
    const count = Math.min(1 + n, 9)
    const vmax = Math.max(this.craft.p.vmax, 6)
    for (let i = 0; i < count; i++) {
      const p = freeSpot(w, rnd, this.craft.pos.x, this.craft.pos.z, 260, 420, 25 + rnd() * 35, 4, false)
      this.spawnEntity({
        kind: 'hostile', model: 'drone', pos: p, home: p.clone(), wp: p.clone(), radius: 0.5, hp: 20 + 6 * n, value: Math.round(100 * (1 + 0.25 * (n - 1))),
        color: '#e23d3d', heat: 0.9, speed: Math.min(vmax * 0.85, 9 + 2 * n), fireCd: 1 + rnd() * 2, fireRate: 0.7 + 0.15 * n, spreadDeg: Math.max(1.2, 4.5 - 0.35 * n),
        standoff: 35 + rnd() * 30, orbit: rnd() < 0.5 ? -1 : 1, track: 0, aiT: rnd(),
      })
    }
    this.wave = n
    this.stats.wave = n
    this.say(`Wave ${n}`, 'bad')
    this.onSound?.('wave')
  }

  // ─────────────────────────────── scoring ───────────────────────────────

  private add(points: number, label: string, at?: THREE.Vector3, kind: Popup['kind'] = 'good') {
    if (!points) return
    this.score += points
    this.breakdown.set(label, (this.breakdown.get(label) ?? 0) + points)
    if (at) this.popups.push({ pos: at.clone(), text: `${points > 0 ? '+' : ''}${points}`, age: 0, kind })
  }
  private log(text: string, kind: FeedItem['kind'] = 'info', pts?: number) {
    this.feed.push({ t: this.t, text, kind, pts })
    if (this.feed.length > 6) this.feed.shift()
  }
  say(text: string, kind: 'good' | 'bad' | 'info' = 'info') { this.flash = { text, t: this.t, kind } }

  objective(): { label: string; detail: string; done: number; total: number } {
    const m = this.mission.id
    const alive = (k: EntityKind) => this.entities.filter(e => e.kind === k)
    if (m === 'rings') return { label: 'Rings', detail: `Thread ring ${Math.min(this.nextRing + 1, this.rings.length)}`, done: this.nextRing, total: this.rings.length }
    if (m === 'targets') {
      const all = this.entities.filter(e => e.kind === 'target' || e.kind === 'balloon')
      return { label: 'Targets', detail: 'Destroy every target', done: all.filter(e => e.state !== 'active').length, total: all.length }
    }
    if (m === 'intercept') {
      const all = alive('rogue')
      return { label: 'Rogues', detail: 'Down or capture the rogue drones', done: all.filter(e => e.state !== 'active').length, total: all.length }
    }
    if (m === 'delivery') {
      if (this.craft.p.kind === 'wing') {
        const d = this.stats.deliveries
        return { label: 'Air drops', detail: this.pods ? `Drop pods on the pads (B) · ${this.pods} left` : 'Pods away', done: d, total: 5 }
      }
      const crates = alive('crate')
      return {
        label: 'Delivered', detail: this.carried ? `Carrying ${this.carried.mass!.toFixed(2)} kg — set it on a pad (B to release)` : `Hook a crate (B within ${this.hookReach} m)`,
        done: crates.filter(c => c.state === 'delivered').length, total: crates.filter(c => c.state !== 'dead').length,
      }
    }
    if (m === 'recon') {
      const z = this.zones.find(z => !z.done && this.inZone(z))
      return { label: 'Zones', detail: z ? `Scanning ${Math.round(z.progress * 100)}%` : 'Hold over each zone to scan it', done: this.zones.filter(z => z.done).length, total: this.zones.length }
    }
    if (m === 'survival') {
      const h = alive('hostile').filter(e => e.state === 'active').length
      return { label: `Wave ${this.wave}`, detail: h ? `${h} hostile${h === 1 ? '' : 's'} inbound` : 'Next wave incoming', done: this.stats.kills + this.stats.captures, total: 0 }
    }
    return { label: 'Free flight', detail: this.weapons.length ? 'Practice targets are out on the range' : 'No clock. Explore.', done: 0, total: 0 }
  }

  /** The point the HUD arrow should point at. */
  objectivePoint(): THREE.Vector3 | null {
    const m = this.mission.id
    const p = this.craft.pos
    const nearest = (pts: THREE.Vector3[]) => pts.reduce<THREE.Vector3 | null>((b, x) => (!b || x.distanceToSquared(p) < b.distanceToSquared(p) ? x : b), null)
    if (m === 'rings') return this.rings[this.nextRing]?.pos ?? null
    if (m === 'delivery') {
      if (this.carried || this.pods) return nearest(this.pads.map(x => x.pos))
      return nearest(this.entities.filter(e => e.kind === 'crate' && e.state === 'active').map(e => e.pos))
    }
    if (m === 'recon') return nearest(this.zones.filter(z => !z.done).map(z => z.pos))
    return null
  }

  // ─────────────────────────────── input actions ───────────────────────────────

  setAim(origin: THREE.Vector3, dir: THREE.Vector3) { this.aim.origin.copy(origin); this.aim.dir.copy(dir).normalize() }

  toggleSystem(i: number) {
    const s = this.systems[i]
    if (!s || this.over || this.countdown > 0) return
    const id = s.def.id
    if (id === 'smoke') {
      if (s.charges <= 0) { this.onSound?.('empty'); return }
      s.charges--
      this.smoke.push({ pos: this.craft.pos.clone(), r: Math.max(9, this.span * 6), until: this.t + 12 })
      for (let k = 0; k < 10; k++) this.effects.push({ kind: 'smoke', pos: this.craft.pos.clone().add(new THREE.Vector3((this.rnd() - 0.5) * 6, (this.rnd() - 0.5) * 4, (this.rnd() - 0.5) * 6)), age: -k * 0.08, dur: 12, size: 4 + this.rnd() * 4 })
      for (const e of this.entities) if (e.kind === 'hostile') e.track = 0
      this.say('Smoke screen', 'info'); this.onSound?.('smoke')
      return
    }
    if (id === 'carrier') {
      if (s.charges <= 0) { this.onSound?.('empty'); return }
      s.charges--
      const p = this.bodyToWorld(new THREE.Vector3(0, -0.15, 0))
      const v = this.craft.vel.clone().add(new THREE.Vector3(0, -2, 0))
      this.spawnEntity({ kind: 'micro', model: 'micro', pos: p, vel: v, radius: 0.18, hp: 5, value: 0, color: '#38d39f', heat: 0.7, life: 40, speed: 24, target: null })
      this.say('Micro-drone away', 'info'); this.onSound?.('launch')
      return
    }
    if (id === 'parachute' || id === 'stealth' || id === 'winch') {
      this.say(id === 'parachute' ? (this.chuteReady ? 'Chute armed — deploys on a fatal hit' : 'Chute used') : id === 'stealth' ? 'Stealth skin is passive' : `Winch: ${this.hookReach} m reach (B)`, 'info')
      return
    }
    s.active = !s.active
    if (id === 'lidar' && this.lidar) { this.lidar.on = s.active; if (!s.active) this.lidar.count = 0 }
    this.say(`${s.def.short} ${s.active ? 'on' : 'off'}`, 'info')
  }

  hook() {
    if (this.over || this.countdown > 0) return
    const c = this.craft
    if (this.pods > 0) {
      this.pods--
      const pod: Projectile = { kind: 'pod', pos: this.bodyToWorld(new THREE.Vector3(0, -0.2, 0)), prev: new THREE.Vector3(), vel: c.vel.clone(), age: 0, life: 30, target: null, dead: false, dmg: 0 }
      pod.prev.copy(pod.pos)
      this.projectiles.push(pod)
      c.extraMass -= c.p.mass * 0.03
      this.onSound?.('drop')
      return
    }
    if (this.carried) {
      const e = this.carried
      e.carried = false
      this.carried = null
      c.extraMass -= e.mass ?? 0
      this.onSound?.('drop')
      return
    }
    if (c.p.kind === 'wing') { this.say('Aeroplanes cannot hook cargo', 'bad'); return }
    let best: Entity | null = null, bestD = Infinity
    for (const e of this.entities) {
      if (e.kind !== 'crate' || e.state !== 'active') continue
      const dx = e.pos.x - c.pos.x, dz = e.pos.z - c.pos.z
      const dy = c.pos.y - (e.pos.y + e.radius)
      const h = Math.hypot(dx, dz)
      if (h < Math.max(2, this.span) && dy > -0.3 && dy < this.hookReach + 0.5 && h + dy < bestD) { best = e; bestD = h + dy }
    }
    if (!best) {
      this.say(this.hasWinch ? 'No crate under you (15 m winch)' : 'Get within 2.5 m above a crate', 'bad')
      this.onSound?.('empty')
      return
    }
    this.carried = best
    best.carried = true
    this.cable = clamp(c.pos.y - best.pos.y, 1.2, this.hookReach + 1)
    c.extraMass += best.mass ?? 0
    const twr = c.p.Tmax / ((c.mass) * G)
    this.say(twr < 1.05 ? `Too heavy: ${best.mass!.toFixed(2)} kg — you can't climb` : `Hooked ${best.mass!.toFixed(2)} kg`, twr < 1.05 ? 'bad' : 'good')
    this.onSound?.('pickup')
  }

  transition() {
    const msg = this.craft.toggleTransition()
    if (msg) this.say(msg, 'info')
  }

  // ─────────────────────────────── stepping ───────────────────────────────

  bodyToWorld(local: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(local).applyQuaternion(this.craft.orientation(_q)).add(this.craft.pos)
  }

  update(dt: number, inp: Input, fire: [boolean, boolean]) {
    if (this.over || this.paused) return
    if (this.countdown > 0) {
      this.countdown -= dt
      if (this.countdown <= 0) { this.say('GO', 'good'); this.onSound?.('ring') }
      return
    }
    this.t += dt
    const c = this.craft
    c.step(dt, inp, this.world)
    if (!c.landed) this.stats.airtime += dt
    this.stats.distance = c.odometer
    this.stats.maxSpeed = c.maxSpeed

    this.updateWeapons(dt, fire)
    this.updateProjectiles(dt)
    this.updateEntities(dt)
    this.updateCarried(dt)
    this.updateEffects(dt)
    this.updateMission(dt)
    this.updateWarnings(dt)
    this.checkEnd()
  }

  private updateWarnings(dt: number) {
    this.warnClock -= dt
    const c = this.craft
    if (c.chuted && c.landed) { this.landedT += dt; if (this.landedT > 1.2) { c.chuted = false; this.landedT = 0; this.say('Chute released — fly on', 'info') } }
    if (this.warnClock <= 0 && (c.battery < 0.15 || c.hp < c.p.hp * 0.25)) { this.warnClock = 2.5; this.onSound?.('warn') }
  }

  warnings(): string[] {
    const c = this.craft
    const out: string[] = []
    if (c.energyWh <= 0) out.push('BATTERY EMPTY')
    else if (c.battery < 0.15) out.push('LOW BATTERY')
    if (c.hp < c.p.hp * 0.25) out.push('CRITICAL DAMAGE')
    if (c.mode === 'cruise' && c.airspeed < c.p.stall * 1.05) out.push('STALL')
    if (c.mode === 'cruise' && c.vel.y < -6 && c.agl(this.world) < 25) out.push('PULL UP')
    if (c.mode === 'hover' && !c.landed && c.thrustN >= c.p.Tmax * 0.99 && c.vel.y < -0.5) out.push('OVERLOADED')
    if (c.chuted) out.push('CHUTE')
    return out
  }

  private onCraftDamage(amount: number, cause: string) {
    const c = this.craft
    this.stats.damageTaken += amount
    this.hurtT = this.t
    this.onSound?.('hurt', c.pos, Math.min(1, amount / 30))
    if (c.hp <= 0 && this.chuteReady && cause !== 'water') {
      this.chuteReady = false
      c.alive = true
      c.hp = Math.max(1, c.p.hp * 0.15)
      c.chuted = true
      if (c.mode === 'cruise') { c.mode = 'hover'; c.vel.multiplyScalar(0.3) }
      this.effects.push({ kind: 'flash', pos: c.pos.clone(), age: 0, dur: 0.4, size: 2 })
      this.say('Recovery chute deployed', 'info')
      this.onSound?.('chute')
      const s = this.systems.find(x => x.def.id === 'parachute'); if (s) { s.charges = 0; s.active = false }
      return
    }
    if (c.hp <= 0) {
      this.explode(c.pos.clone(), 2 + this.span, 0, 'player')
      this.say(cause === 'water' ? 'Splashdown' : 'Airframe destroyed', 'bad')
    }
  }

  // ─────────────────────────────── weapons ───────────────────────────────

  private computeAim() {
    const a = this.aim
    let best = 800, ent: Entity | null = null
    for (const e of this.entities) {
      if (e.state !== 'active' || e.kind === 'micro' || e.kind === 'crate') continue
      _v.subVectors(e.pos, a.origin)
      const along = _v.dot(a.dir)
      if (along < 0 || along > best) continue
      const perp2 = _v.lengthSq() - along * along
      const r = e.radius * 1.6 + along * 0.004
      if (perp2 < r * r) { best = along; ent = e }
    }
    const hit = raycastWorld(this.world, a.origin, a.dir, best)
    if (hit && hit.t < best) { best = hit.t; ent = null; a.worldHit = true } else a.worldHit = !!ent
    a.dist = best
    a.entity = ent
    a.point.copy(a.origin).addScaledVector(a.dir, best)
  }

  private spreadRad(base: number) {
    const c = this.craft
    const vib = 1 + c.speed / 30 + (c.mode === 'hover' ? Math.abs(c.pitch) + Math.abs(c.roll) : 0) * 0.5
    return base * DEG * this.perf.accuracy.spreadMult * vib / 2.4
  }

  private updateWeapons(dt: number, fire: [boolean, boolean]) {
    this.aimClock -= dt
    if (this.aimClock <= 0) { this.computeAim(); this.aimClock = 1 / 30 }
    this.laser.on = false
    const c = this.craft
    this.weapons.forEach((w, i) => {
      const held = fire[i] ?? false
      const pressed = held && !w.heldPrev
      w.heldPrev = held
      w.cd = Math.max(0, w.cd - dt)
      w.firing = false
      const id = w.def.id
      const s = w.def.stats as Record<string, number>
      const muzzle = this.bodyToWorld(w.muzzle)
      const target = this.aim.point
      const dir = _w.subVectors(target, muzzle)
      if (dir.lengthSq() < 25 || this.aim.dist < 5) dir.copy(this.aim.dir)
      dir.normalize()

      if (id === 'missile') {
        // lock: keep the target in the reticle for lockS seconds
        let cand: Entity | null = null, bestAng = 6 * DEG
        for (const e of this.entities) {
          if (e.state !== 'active' || e.kind === 'micro' || e.kind === 'crate') continue
          _v.subVectors(e.pos, this.aim.origin)
          const d = _v.length()
          if (d > s.range || d < 8) continue
          const ang = Math.acos(clamp(_v.dot(this.aim.dir) / d, -1, 1))
          if (ang < bestAng && !(this.aim.worldHit && !this.aim.entity && this.aim.dist < d - 3)) { bestAng = ang; cand = e }
        }
        if (cand && cand === w.lockTarget) { const before = w.lockT; w.lockT += dt; if (before < s.lockS && w.lockT >= s.lockS) this.onSound?.('lock') }
        else { w.lockTarget = cand; w.lockT = 0 }
      }

      if (id === 'kinetic') {
        if (held && w.cd <= 0) {
          if (w.ammo <= 0) { if (pressed) this.onSound?.('empty'); return }
          w.ammo--; w.cd = 1 / s.rate; w.firing = true
          const d = randCone(dir, this.spreadRad(s.spreadDeg), this.rnd, new THREE.Vector3())
          const p: Projectile = { kind: 'bullet', pos: muzzle.clone(), prev: muzzle.clone(), vel: d.multiplyScalar(s.speed).add(c.vel), age: 0, life: (s.range / s.speed) * 1.25, target: null, dead: false, dmg: s.damage }
          this.projectiles.push(p)
          this.stats.shots++
          c.vel.addScaledVector(dir, -(s.recoil * 0.09) / c.mass)
          this.effects.push({ kind: 'flash', pos: muzzle.clone(), age: 0, dur: 0.05, size: 0.25 })
          this.onSound?.('shot', muzzle)
        }
      } else if (id === 'bomb') {
        if (pressed) {
          if (w.ammo <= 0) { this.onSound?.('empty'); return }
          w.ammo--
          const p: Projectile = { kind: 'bomb', pos: this.bodyToWorld(new THREE.Vector3(w.muzzle.x, w.muzzle.y - 0.05, w.muzzle.z)), prev: new THREE.Vector3(), vel: c.vel.clone().add(new THREE.Vector3(0, -0.5, 0)), age: 0, life: 40, target: null, dead: false, dmg: s.damage }
          p.prev.copy(p.pos)
          this.projectiles.push(p)
          c.extraMass -= w.def.massKg * 0.18
          this.onSound?.('drop', muzzle)
        }
      } else if (id === 'net') {
        if (pressed && w.cd <= 0) {
          if (w.ammo <= 0) { this.onSound?.('empty'); return }
          w.ammo--; w.cd = 0.8
          const p: Projectile = { kind: 'net', pos: muzzle.clone(), prev: muzzle.clone(), vel: dir.clone().multiplyScalar(s.speed).add(c.vel), age: 0, life: s.range / s.speed, target: null, dead: false, dmg: 0 }
          this.projectiles.push(p)
          this.onSound?.('net', muzzle)
        }
      } else if (id === 'missile') {
        if (pressed && w.cd <= 0) {
          if (w.ammo <= 0) { this.onSound?.('empty'); return }
          w.ammo--; w.cd = 0.6
          const locked = w.lockT >= s.lockS ? w.lockTarget : null
          const p: Projectile = { kind: 'missile', pos: muzzle.clone(), prev: muzzle.clone(), vel: c.vel.clone().addScaledVector(dir, 6), age: 0, life: 9, target: locked, dead: false, dmg: s.damage }
          ;(p as Projectile & { dir: THREE.Vector3 }).dir = dir.clone()
          this.projectiles.push(p)
          w.lockT = 0
          this.say(locked ? 'Missile away — locked' : 'Missile away — no lock', 'info')
          this.onSound?.('missile', muzzle)
        }
      } else if (id === 'laser') {
        if (held) {
          w.firing = true
          this.laser.on = true
          this.laser.from.copy(muzzle)
          this.laser.to.copy(this.aim.point)
          const e = this.aim.entity
          if (e && this.aim.dist < s.range) {
            if (e.painted <= 0) { this.log(`Target painted`, 'info'); this.onSound?.('lock') }
            e.painted = 12
            const dps = e.kind === 'balloon' || e.kind === 'hostile' || e.kind === 'rogue' ? 9 : 3.5
            this.damageEntity(e, dps * dt, 'laser')
          }
        }
      } else if (id === 'emp') {
        if (pressed) {
          if (w.cd > 0) { this.onSound?.('empty'); this.say(`Pulse recharging ${w.cd.toFixed(0)} s`, 'bad'); return }
          w.cd = s.cooldownS
          const r = s.radius
          this.effects.push({ kind: 'emp', pos: c.pos.clone(), age: 0, dur: 0.9, size: r })
          let n = 0
          for (const e of this.entities) {
            if ((e.kind === 'hostile' || e.kind === 'rogue') && e.state === 'active' && e.pos.distanceTo(c.pos) < r) {
              e.disabled = true; e.state = 'falling'; n++
            }
          }
          this.say(n ? `Pulse: ${n} drone${n > 1 ? 's' : ''} disabled` : 'Pulse: nothing in range', n ? 'good' : 'info')
          this.onSound?.('emp', c.pos)
          // the pulse draws its charge from the flight battery
          c.energyWh = Math.max(0, c.energyWh - (w.def.powerW * 3) / 3600)
        }
      }
    })
  }

  private damageEntity(e: Entity, dmg: number, cause: 'bullet' | 'blast' | 'laser' | 'ram' | 'micro') {
    if (e.state !== 'active' || dmg <= 0) return
    e.hp -= dmg
    if (e.hp > 0) return
    const painted = e.painted > 0
    e.state = e.kind === 'hostile' || e.kind === 'rogue' ? 'falling' : 'dead'
    e.deadT = this.t
    this.version++
    if (e.kind === 'crate') return
    if (e.model === 'balloon') this.effects.push({ kind: 'spark', pos: e.pos.clone(), age: 0, dur: 0.5, size: 2 })
    else this.explode(e.pos.clone(), e.kind === 'target' ? 4 : 2, 0, 'entity')
    this.stats.kills++
    const pts = Math.round(e.value * (painted ? 2 : 1))
    this.add(pts, painted ? 'Painted kills' : 'Kills', e.pos, painted ? 'gold' : 'good')
    this.log(`${e.model === 'balloon' ? 'Balloon' : e.kind === 'target' ? (e.model === 'bunker' ? 'Bunker' : 'Vehicle') : 'Drone'} down${painted ? ' (painted ×2)' : ''}${cause === 'micro' ? ' by micro-drone' : ''}`, 'good', pts)
  }

  private capture(e: Entity, how: string) {
    if (e.state !== 'active' && e.state !== 'falling') return
    if (e.state === 'falling' && !e.disabled) return
    e.netted = true
    e.state = 'falling'
    this.version++
    this.stats.captures++
    const pts = Math.round(e.value * 2 * (e.painted > 0 ? 1.5 : 1))
    this.add(pts, 'Captures', e.pos, 'gold')
    this.log(`Captured ${e.model === 'balloon' ? 'balloon' : 'drone'} — ${how}`, 'good', pts)
    this.onSound?.('capture', e.pos)
  }

  explode(at: THREE.Vector3, radius: number, dmg: number, source: 'player' | 'entity' | 'weapon') {
    this.effects.push({ kind: 'boom', pos: at.clone(), age: 0, dur: 0.9, size: radius })
    for (let i = 0; i < 4; i++) this.effects.push({ kind: 'smoke', pos: at.clone().add(new THREE.Vector3((this.rnd() - 0.5) * radius, this.rnd() * radius * 0.5, (this.rnd() - 0.5) * radius)), age: -0.1 * i, dur: 3 + this.rnd() * 2, size: radius * 0.6 })
    this.onSound?.('boom', at, Math.min(1, radius / 6))
    if (dmg <= 0) return
    for (const e of this.entities) {
      if (e.state !== 'active' || e.kind === 'micro') continue
      const d = e.pos.distanceTo(at) - e.radius
      if (d < radius) {
        if (e.kind === 'crate') { e.broken = true; continue }
        this.damageEntity(e, dmg * (1 - Math.max(d, 0) / radius), 'blast')
      }
    }
    if (source === 'weapon') {
      const d = this.craft.pos.distanceTo(at)
      if (d < radius) this.craft.damage(dmg * 0.6 * (1 - d / radius), 'blast')
    }
  }

  private updateProjectiles(dt: number) {
    const w = this.world, c = this.craft
    for (const p of this.projectiles) {
      if (p.dead) continue
      p.age += dt
      p.prev.copy(p.pos)
      if (p.kind === 'bullet' || p.kind === 'enemy') {
        p.pos.addScaledVector(p.vel, dt)
      } else if (p.kind === 'bomb' || p.kind === 'pod') {
        p.vel.y -= G * dt
        p.vel.multiplyScalar(1 - 0.02 * dt)
        p.pos.addScaledVector(p.vel, dt)
      } else if (p.kind === 'net') {
        p.vel.y -= 3 * dt
        p.vel.multiplyScalar(1 - 0.4 * dt)
        p.pos.addScaledVector(p.vel, dt)
      } else if (p.kind === 'missile') {
        const m = p as Projectile & { dir: THREE.Vector3 }
        const spd = Math.min(90, 12 + p.age * 140)
        if (p.target && p.target.state === 'active' && p.age > 0.15) {
          const lead = p.target.pos.clone().addScaledVector(p.target.vel, p.pos.distanceTo(p.target.pos) / Math.max(spd, 1))
          const want = lead.sub(p.pos).normalize()
          const ang = m.dir.angleTo(want)
          const maxTurn = 3.2 * dt
          if (ang > 1e-4) m.dir.lerp(want, Math.min(1, maxTurn / ang)).normalize()
        }
        p.vel.copy(m.dir).multiplyScalar(spd)
        p.pos.addScaledVector(p.vel, dt)
        if (Math.floor(p.age * 30) !== Math.floor((p.age - dt) * 30)) this.effects.push({ kind: 'trail', pos: p.pos.clone(), age: 0, dur: 1.4, size: 0.5 })
        if (p.target && p.target.state === 'active' && p.pos.distanceTo(p.target.pos) < 2.5 + p.target.radius) {
          p.dead = true; this.explode(p.pos.clone(), 6, p.dmg, 'weapon'); continue
        }
      }
      if (p.age > p.life) {
        p.dead = true
        if (p.kind === 'missile') this.explode(p.pos.clone(), 5, p.dmg * 0.5, 'weapon')
        continue
      }
      // hits: entities
      if (p.kind === 'bullet' || p.kind === 'missile' || p.kind === 'net') {
        let hitE: Entity | null = null, hf = 2
        for (const e of this.entities) {
          if (e.state !== 'active' || e.kind === 'micro' || (p.kind !== 'net' && e.kind === 'crate')) continue
          const r = p.kind === 'net' ? e.radius + (this.weapons.find(x => x.def.id === 'net')?.def.stats.netM as number ?? 4) * 0.5 * Math.min(1, p.age * 3) : e.radius
          const f = segSphere(p.prev, p.pos, e.pos, r)
          if (f >= 0 && f < hf) { hf = f; hitE = e }
        }
        if (hitE) {
          p.dead = true
          if (p.kind === 'bullet') {
            this.stats.hits++
            this.damageEntity(hitE, p.dmg * (hitE.painted > 0 ? 1.25 : 1), 'bullet')
            this.effects.push({ kind: 'spark', pos: p.pos.clone(), age: 0, dur: 0.25, size: 0.6 })
            this.onSound?.('hit', p.pos)
          } else if (p.kind === 'missile') {
            this.explode(p.pos.clone(), 6, p.dmg, 'weapon')
          } else if (p.kind === 'net') {
            if (hitE.kind === 'hostile' || hitE.kind === 'rogue' || hitE.kind === 'balloon') this.capture(hitE, 'netted')
            this.effects.push({ kind: 'net', pos: hitE.pos.clone(), age: 0, dur: 0.6, size: 3 })
          }
          continue
        }
      }
      if (p.kind === 'enemy') {
        const f = segSphere(p.prev, p.pos, c.pos, Math.max(c.p.radius * 0.7, 0.3))
        if (f >= 0) { p.dead = true; c.damage(p.dmg, 'gunfire'); this.effects.push({ kind: 'spark', pos: p.pos.clone(), age: 0, dur: 0.2, size: 0.4 }); continue }
      }
      // hits: world
      const hw = segmentHitsWorld(w, p.prev, p.pos)
      if (hw) {
        const at = p.prev.clone().lerp(p.pos, hw.f)
        p.dead = true
        if (p.kind === 'bomb') this.explode(at, (this.weapons.find(x => x.def.id === 'bomb')?.def.stats.blastM as number) ?? 7, p.dmg, 'weapon')
        else if (p.kind === 'missile') this.explode(at, 6, p.dmg, 'weapon')
        else if (p.kind === 'pod') this.landPod(at)
        else this.effects.push({ kind: hw.kind === 'water' ? 'splash' : 'dust', pos: at, age: 0, dur: 0.5, size: p.kind === 'net' ? 2 : 0.6 })
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead)
  }

  private landPod(at: THREE.Vector3) {
    let best = Infinity, pad: Pad | null = null
    for (const p of this.pads) { const d = Math.hypot(at.x - p.pos.x, at.z - p.pos.z); if (d < best) { best = d; pad = p } }
    this.effects.push({ kind: 'dust', pos: at.clone(), age: 0, dur: 0.8, size: 2 })
    if (pad && best < pad.radius * 2) {
      this.stats.deliveries++
      const acc = Math.round(clamp(1 - best / (pad.radius * 2), 0, 1) * 200)
      this.add(300 + acc, 'Deliveries', at)
      this.log(`Pod on target — ${best.toFixed(1)} m from centre`, 'good', 300 + acc)
      this.onSound?.('deliver', at)
    } else {
      this.log(`Pod missed by ${Math.max(0, best - pad!.radius * 2).toFixed(0)} m`, 'bad')
    }
  }

  // ─────────────────────────────── entities ───────────────────────────────

  private playerVisibleFrom(p: THREE.Vector3, d: number): boolean {
    const c = this.craft
    let R = 260 * this.stealthFactor
    if (this.night) R *= this.sysOn('searchlight') ? 1.4 : 0.6
    if (d > R) return false
    for (const s of this.smoke) if (s.until > this.t && (c.pos.distanceTo(s.pos) < s.r || p.distanceTo(s.pos) < s.r)) return false
    const dir = _v.subVectors(c.pos, p).normalize()
    const hit = raycastWorld(this.world, p, dir, d - 1)
    return !hit
  }

  private updateEntities(dt: number) {
    const c = this.craft, w = this.world
    this.aiClock -= dt
    const think = this.aiClock <= 0
    if (think) this.aiClock = 0.25
    this.visClock -= dt
    const vis = this.visClock <= 0
    if (vis) this.visClock = 0.25

    for (const e of this.entities) {
      e.painted = Math.max(0, e.painted - dt)
      if (vis) this.updateSeen(e)

      if (e.state === 'falling') {
        e.vel.y -= G * dt * (e.netted ? 0.55 : 1)
        e.vel.x *= 1 - dt; e.vel.z *= 1 - dt
        e.pos.addScaledVector(e.vel, dt)
        const g = groundAt(w, e.pos.x, e.pos.z)
        if (e.pos.y - e.radius < g) {
          e.pos.y = g + e.radius
          e.vel.set(0, 0, 0)
          if (e.disabled && !e.netted) this.capture(e, 'pulse')
          e.state = e.netted || e.disabled ? 'captured' : 'dead'
          if (e.state === 'dead') this.explode(e.pos.clone(), 1.5, 0, 'entity')
          this.version++
        }
        continue
      }
      if (e.state !== 'active') continue

      if (e.kind === 'target' && e.path && e.speed) {
        const goal = e.path[e.pathI! % e.path.length]
        _v.subVectors(goal, e.pos).setY(0)
        if (_v.length() < 2) e.pathI = (e.pathI! + 1) % e.path.length
        else { _v.normalize(); e.vel.copy(_v).multiplyScalar(e.speed); e.pos.addScaledVector(e.vel, dt); e.pos.y = groundAt(w, e.pos.x, e.pos.z); e.yaw = Math.atan2(-_v.z, _v.x) }
      } else if (e.kind === 'balloon') {
        e.pos.y = e.home!.y + Math.sin(this.t * 0.7 + e.id) * 0.8
        e.pos.x = e.home!.x + Math.sin(this.t * 0.31 + e.id * 2) * 1.2 + w.wind.x * 0.05
      } else if (e.kind === 'hostile' || e.kind === 'rogue') {
        this.updateDroneAI(e, dt, think)
      } else if (e.kind === 'micro') {
        this.updateMicro(e, dt, think)
      } else if (e.kind === 'crate' && !e.carried) {
        // free crate: fall and settle
        e.vel.y -= G * dt
        e.pos.addScaledVector(e.vel, dt)
        const g = groundAt(w, e.pos.x, e.pos.z)
        if (e.pos.y - e.radius <= g) {
          const impact = -e.vel.y
          e.pos.y = g + e.radius
          if (impact > 7 && !e.broken) { e.broken = true; this.log('Crate damaged in the drop', 'bad'); this.effects.push({ kind: 'dust', pos: e.pos.clone(), age: 0, dur: 0.6, size: 1.5 }) }
          e.vel.set(0, 0, 0)
          this.checkDelivered(e)
        }
        if (w.water && g <= 0.01 && e.pos.y < 0.5) { e.state = 'dead'; this.effects.push({ kind: 'splash', pos: e.pos.clone(), age: 0, dur: 0.8, size: 2 }); this.log('Crate lost in the water', 'bad'); this.version++ }
      }

      // ramming
      if (e.kind !== 'crate' && e.kind !== 'micro') {
        const d = e.pos.distanceTo(c.pos)
        if (d < e.radius + Math.max(c.p.radius * 0.6, 0.15)) {
          const rel = _v.subVectors(c.vel, e.vel).length()
          c.damage(8 + rel * rel * 0.4, 'collision')
          this.damageEntity(e, 15 + rel * 3, 'ram')
          c.vel.multiplyScalar(-0.3)
        }
      }
    }
  }

  private updateSeen(e: Entity) {
    const c = this.craft
    const d = e.pos.distanceTo(c.pos)
    let R = this.night ? 110 : 420
    if (this.night && (this.sysOn('searchlight') || this.sysOn('thermal'))) R = 260
    if (this.sysOn('radar') && d < 900) { e.seen = true; return }
    if (e.painted > 0) { e.seen = true; return }
    if (d > R) { e.seen = false; return }
    const dir = _v.subVectors(e.pos, c.pos).normalize()
    const hit = raycastWorld(this.world, c.pos, dir, d - e.radius)
    e.seen = !hit
  }

  private updateDroneAI(e: Entity, dt: number, think: boolean) {
    const c = this.craft, w = this.world
    const toP = _w.subVectors(c.pos, e.pos)
    const d = toP.length()
    if (think) {
      if (e.kind === 'hostile') {
        if (c.alive && this.playerVisibleFrom(e.pos, d)) e.track = 6
        else e.track = Math.max(0, (e.track ?? 0) - 0.25)
      }
      if (e.wp && e.pos.distanceTo(e.wp) < 12) {
        const p = freeSpot(w, this.rnd, e.home!.x, e.home!.z, 20, 160, 20 + this.rnd() * 45, 3, false)
        e.wp.copy(p)
      }
    }
    const desired = new THREE.Vector3()
    const sp = e.speed ?? 10
    if (e.kind === 'hostile' && (e.track ?? 0) > 0 && c.alive) {
      const radial = toP.clone().setY(0)
      const rl = radial.length() || 1
      radial.divideScalar(rl)
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(e.orbit ?? 1)
      const err = d - (e.standoff ?? 45)
      desired.copy(radial).multiplyScalar(clamp(err / 15, -1, 1)).addScaledVector(tangent, 0.75).normalize().multiplyScalar(sp)
      desired.y = clamp((c.pos.y + 5 - e.pos.y) * 0.6, -5, 5)
      e.fireCd = (e.fireCd ?? 1) - dt
      if (e.fireCd <= 0 && d < 150 && (e.track ?? 0) > 5.5) {
        e.fireCd = 1 / (e.fireRate ?? 1)
        const lead = c.pos.clone().addScaledVector(c.vel, d / 160)
        const dir = lead.sub(e.pos).normalize()
        randCone(dir, ((e.spreadDeg ?? 3) + d * 0.015) * DEG, this.rnd, dir)
        const p: Projectile = { kind: 'enemy', pos: e.pos.clone(), prev: e.pos.clone(), vel: dir.multiplyScalar(160), age: 0, life: 1.4, target: null, dead: false, dmg: 4 + this.wave * 0.6 }
        this.projectiles.push(p)
        this.onSound?.('enemyShot', e.pos, 0.6)
      }
    } else if (e.kind === 'rogue' && d < 60 && c.alive) {
      // flee and jink
      desired.copy(toP).multiplyScalar(-1).setY(0).normalize().multiplyScalar(sp * 1.3)
      desired.y = Math.sin(this.t * 2 + e.id) * 4
    } else {
      desired.subVectors(e.wp ?? e.pos, e.pos)
      const l = desired.length()
      if (l > 0.1) desired.multiplyScalar((sp * 0.6) / l)
    }
    // keep off the ground and out of buildings
    const g = groundAt(w, e.pos.x, e.pos.z)
    if (e.pos.y < g + 10) desired.y = Math.max(desired.y, 4)
    const ahead = _v.copy(e.pos).addScaledVector(e.vel, 1.2)
    if (insideSolid(w, ahead, 3)) desired.y = Math.max(desired.y, sp * 0.8)
    e.vel.lerp(desired, 1 - Math.exp(-dt * 1.6))
    e.pos.addScaledVector(e.vel, dt)
    if (Math.abs(e.pos.x) > w.half - 20 || Math.abs(e.pos.z) > w.half - 20) { e.vel.x *= -1; e.vel.z *= -1 }
    if (e.vel.lengthSq() > 0.5) e.yaw = Math.atan2(-e.vel.z, e.vel.x)
  }

  private updateMicro(e: Entity, dt: number, think: boolean) {
    const c = this.craft
    e.life! -= dt
    if (e.life! <= 0) { e.state = 'falling'; e.disabled = true; e.netted = true; this.version++; return }
    if (think && (!e.target || e.target.state !== 'active')) {
      let best: Entity | null = null, bd = 450
      for (const o of this.entities) {
        if (o.state !== 'active' || !(o.kind === 'hostile' || o.kind === 'rogue' || o.kind === 'target' || o.kind === 'balloon')) continue
        const d = o.pos.distanceTo(e.pos) * (o.painted > 0 ? 0.5 : 1)
        if (d < bd) { bd = d; best = o }
      }
      e.target = best
    }
    const desired = new THREE.Vector3()
    if (e.target) {
      desired.subVectors(e.target.pos, e.pos)
      const d = desired.length()
      desired.multiplyScalar((e.speed ?? 22) / Math.max(d, 0.01))
      if (d < 25) e.target.painted = Math.max(e.target.painted, 3)
      if (d < e.target.radius + 1.2) {
        this.damageEntity(e.target, 30, 'micro')
        this.explode(e.pos.clone(), 2, 0, 'entity')
        e.state = 'dead'; this.version++
        return
      }
    } else {
      const a = this.t * 0.8 + e.id
      desired.set(c.pos.x + Math.cos(a) * 8 - e.pos.x, c.pos.y + 3 - e.pos.y, c.pos.z + Math.sin(a) * 8 - e.pos.z).multiplyScalar(1.5)
    }
    const g = groundAt(this.world, e.pos.x, e.pos.z)
    if (e.pos.y < g + 3) desired.y = Math.max(desired.y, 3)
    e.vel.lerp(desired, 1 - Math.exp(-dt * 3))
    e.pos.addScaledVector(e.vel, dt)
    if (e.vel.lengthSq() > 0.5) e.yaw = Math.atan2(-e.vel.z, e.vel.x)
  }

  private updateCarried(dt: number) {
    const e = this.carried
    if (!e) return
    const c = this.craft
    if (this.hasWinch && this.cable > 4) this.cable = Math.max(4, this.cable - 2.5 * dt)
    const anchor = this.bodyToWorld(new THREE.Vector3(0, -this.span * 0.1, 0))
    e.vel.y -= G * dt
    e.vel.multiplyScalar(1 - 0.6 * dt)
    e.pos.addScaledVector(e.vel, dt)
    _v.subVectors(e.pos, anchor)
    const L = this.cable + e.radius
    const d = _v.length()
    if (d > L) {
      _v.divideScalar(d)
      e.pos.copy(anchor).addScaledVector(_v, L)
      const vr = e.vel.dot(_v) - c.vel.dot(_v)
      if (vr > 0) e.vel.addScaledVector(_v, -vr)
    }
    const g = groundAt(this.world, e.pos.x, e.pos.z)
    if (e.pos.y - e.radius < g) { e.pos.y = g + e.radius; e.vel.y = Math.max(0, e.vel.y); e.vel.x *= 0.8; e.vel.z *= 0.8 }
    if (insideSolid(this.world, e.pos, e.radius * 0.5)) { e.vel.multiplyScalar(-0.3); c.vel.multiplyScalar(0.9) }
    e.yaw += e.vel.x * dt * 0.2
    // set it down on a pad: automatic release once it rests inside
    for (const p of this.pads) {
      if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < p.radius && e.pos.y - e.radius < g + 0.15 && e.vel.length() < 1.5) {
        this.hook()
        this.checkDelivered(e)
        break
      }
    }
  }

  private checkDelivered(e: Entity) {
    if (e.state !== 'active') return
    for (const p of this.pads) {
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z)
      if (d < p.radius) {
        e.state = 'delivered'
        this.version++
        this.stats.deliveries++
        const base = 150 + Math.round(120 * Math.log2(1 + (e.mass ?? 0) / 0.2))
        const acc = Math.round(clamp(1 - d / p.radius, 0, 1) * 100)
        const pts = Math.round((base + acc) * (e.broken ? 0.5 : 1))
        this.add(pts, 'Deliveries', e.pos)
        this.log(`Delivered ${e.mass!.toFixed(2)} kg${e.broken ? ' (damaged)' : ''}`, 'good', pts)
        this.onSound?.('deliver', e.pos)
        return
      }
    }
  }

  private updateEffects(dt: number) {
    for (const f of this.effects) {
      f.age += dt
      if (f.vel) f.pos.addScaledVector(f.vel, dt)
      if (f.kind === 'smoke') f.pos.addScaledVector(this.world.wind, dt * 0.3)
    }
    this.effects = this.effects.filter(f => f.age < f.dur)
    for (const p of this.popups) { p.age += dt; p.pos.y += dt * 1.5 }
    this.popups = this.popups.filter(p => p.age < 1.6)
    this.smoke = this.smoke.filter(s => s.until > this.t)
    if (this.version > 0 && this.entities.length > 80) {
      // keep long fights tidy: forget wreckage that has been on the ground a while
      const before = this.entities.length
      this.entities = this.entities.filter(e => e.state === 'active' || e.kind === 'crate' || this.t - e.deadT < 20)
      if (this.entities.length !== before) this.version++
    }
  }

  private inZone(z: Zone) {
    const c = this.craft
    return Math.hypot(c.pos.x - z.pos.x, c.pos.z - z.pos.z) < z.radius && c.agl(this.world) < 120
  }

  private updateMission(dt: number) {
    const c = this.craft, m = this.mission.id
    if (m === 'rings') {
      const r = this.rings[this.nextRing]
      if (r) {
        // crossed the ring plane this step, inside the radius?
        const prev = c.pos.clone().addScaledVector(c.vel, -dt)
        const a = prev.clone().sub(r.pos).dot(r.normal), b = c.pos.clone().sub(r.pos).dot(r.normal)
        if (a < 0 && b >= 0) {
          const f = a / (a - b)
          const hit = prev.lerp(c.pos, f)
          if (hit.distanceTo(r.pos) < r.radius) {
            r.passed = true
            this.nextRing++
            this.stats.rings++
            const center = 1 - hit.distanceTo(r.pos) / r.radius
            const pts = 120 + Math.round(center * 30)
            this.add(pts, 'Rings', r.pos)
            this.say(this.nextRing === this.rings.length ? 'Course complete' : `Ring ${this.nextRing} / ${this.rings.length}`, 'good')
            this.onSound?.('ring')
          }
        }
      }
    }
    if (m === 'recon') {
      let mult = 1
      if (this.sysOn('lidar')) mult *= 2
      if (this.sysOn('thermal')) mult *= 1.5
      if (this.sysOn('radar')) mult *= 1.2
      if (this.night && !this.sysOn('searchlight') && !this.sysOn('thermal') && !this.sysOn('lidar')) mult *= 0.4
      for (const z of this.zones) {
        if (z.done || !this.inZone(z)) continue
        const agl = c.agl(this.world)
        z.progress += dt * 0.13 * mult * clamp((120 - agl) / 90, 0.3, 1)
        if (z.progress >= 1) {
          z.done = true; z.progress = 1
          this.stats.zones++
          this.add(400, 'Zones scanned', z.pos)
          this.say(`Zone ${this.stats.zones} / ${this.zones.length} scanned`, 'good')
          this.onSound?.('zone')
        }
      }
    }
    if (m === 'survival') {
      const active = this.entities.some(e => e.kind === 'hostile' && e.state === 'active')
      if (!active) {
        if (this.waveT <= 0) {
          if (this.wave > 0) { this.add(250 * this.wave, 'Waves cleared'); this.log(`Wave ${this.wave} cleared`, 'good', 250 * this.wave) }
          this.waveT = 4
        }
        this.waveT -= dt
        if (this.waveT <= 0) { this.waveT = 0; this.spawnWave(this.wave + 1) }
      }
      if (Math.floor(this.t) !== Math.floor(this.t - dt)) this.add(5, 'Time survived')
    }
  }

  private checkEnd() {
    const c = this.craft, m = this.mission.id
    if (!c.alive) return this.finish('destroyed')
    if (c.energyWh <= 0 && (c.landed || c.agl(this.world) < 0.5)) return this.finish('battery')
    if (this.mission.timeLimit > 0 && this.t >= this.mission.timeLimit) return this.finish('time')
    const o = this.objective()
    if (m !== 'free' && m !== 'survival' && o.total > 0 && o.done >= o.total) {
      if (m === 'delivery' && this.craft.p.kind === 'wing') { if (this.pods > 0 || this.projectiles.some(p => p.kind === 'pod')) return }
      return this.finish('complete')
    }
    if (m === 'delivery' && this.craft.p.kind === 'wing' && this.pods === 0 && !this.projectiles.some(p => p.kind === 'pod')) return this.finish('complete')
  }

  finish(reason: RunResult['reason']) {
    if (this.over) return
    this.over = true
    const m = this.mission
    const completed = reason === 'complete' || (m.id === 'survival' && reason !== 'quit') || (m.id === 'free')
    if (reason === 'complete' && m.timeLimit > 0) {
      const rate = m.id === 'recon' ? 8 : 10
      this.add(Math.round(this.timeLeft * rate), 'Time bonus')
    }
    if ((m.id === 'targets' || m.id === 'intercept' || m.id === 'survival') && this.stats.shots >= 5) {
      this.add(Math.round(400 * (this.stats.hits / this.stats.shots)), 'Accuracy bonus')
    }
    const stars = m.id === 'free' ? 0 : m.stars.filter(s => this.score >= s).length
    this.result = {
      reason, completed, score: this.score, stars, timeMs: Math.round(this.t * 1000),
      breakdown: [...this.breakdown.entries()].sort((a, b) => b[1] - a[1]), stats: { ...this.stats },
    }
  }

  // ─────────────────────────────── live LiDAR ───────────────────────────────

  /** Fire a batch of Avia beams from the drone into the world. Call once per rendered frame. */
  scanLidar() {
    const L = this.lidar
    if (!L || !L.on || this.countdown > 0 || this.over) return
    const c = this.craft
    const sensor = SENSORS.avia
    if (L.nearAt.distanceTo(c.pos) > 40) { L.near = worldNear(this.world, c.pos, 240); L.nearAt.copy(c.pos) }
    const world = L.near!
    const q = c.orientation(new THREE.Quaternion())
    // the sensor looks along the body forward axis, tilted down by its mount; keep it level-ish (gimbal)
    const yawOnly = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-this.craft.forward().z, this.craft.forward().x), 0, 'YXZ'))
    const mq = (c.mode === 'cruise' ? q : yawOnly).clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), L.mountPitch))
    const origin = this.bodyToWorld(new THREE.Vector3(this.span * 0.35, -0.05, 0))
    const ang: [number, number] = [0, 0]
    const dir = new THREE.Vector3()
    const maxR = 190 * 1.4
    let contacts = 0
    const cand = this.entities.filter(e => e.state === 'active' && e.kind !== 'crate' && e.pos.distanceTo(origin) < maxR)
    for (let i = 0; i < L.rays; i++) {
      L.k += L.decim
      beamAngles(sensor, L.k, ang)
      const az = ang[0], el = ang[1]
      dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), -Math.cos(el) * Math.sin(az)).applyQuaternion(mq)
      let best = maxR, isEnt = false
      for (const e of cand) {
        _v.subVectors(e.pos, origin)
        const along = _v.dot(dir)
        if (along < 0 || along > best) continue
        const perp2 = _v.lengthSq() - along * along
        if (perp2 < e.radius * e.radius) { best = along - Math.sqrt(e.radius * e.radius - perp2); isEnt = true }
      }
      const hit = raycastWorld(world, origin, dir, best)
      if (hit && hit.t < best) { best = hit.t; isEnt = false }
      if (best >= maxR) continue
      // range law: darker surfaces return less far (10% at 190 m, 80% at 450 m) — water barely returns
      const rho = isEnt ? 0.25 : hit?.kind === 'water' ? 0.02 : hit?.kind === 'tree' ? 0.35 : hit?.kind === 'building' ? 0.3 : 0.2
      if (best > 190 * Math.pow(rho / 0.1, 0.42)) continue
      if (isEnt) contacts++
      const j = L.head * 3
      L.pts[j] = origin.x + dir.x * best; L.pts[j + 1] = origin.y + dir.y * best; L.pts[j + 2] = origin.z + dir.z * best
      // colour: entities glow magenta, everything else by range
      if (isEnt) { L.col[j] = 1; L.col[j + 1] = 0.2; L.col[j + 2] = 0.9 }
      else {
        const u = clamp(best / 190, 0, 1)
        L.col[j] = clamp(1.6 - Math.abs(u * 4 - 3) , 0, 1); L.col[j + 1] = clamp(1.6 - Math.abs(u * 4 - 2), 0, 1); L.col[j + 2] = clamp(1.6 - Math.abs(u * 4 - 1), 0, 1)
      }
      L.head = (L.head + 1) % (L.pts.length / 3)
      L.count = Math.min(L.count + 1, L.pts.length / 3)
    }
    L.contacts = L.contacts * 0.9 + contacts * 0.1
    if (contacts) for (const e of cand) if (e.pos.distanceTo(origin) < 190) e.seen = true
  }
}
