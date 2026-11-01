/**
 * Heads-up display. Slow-changing numbers come from a 10 Hz snapshot through React; anything
 * that must track the camera every frame (compass, markers, lock box, bomb sight, minimap) is
 * written straight to the DOM by updateHudFrame().
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import type { FeedItem, Game } from './game'
import { groundAt, type World } from './world'
import { G } from '../engine/performance'
import type { InputManager } from './input'

export interface WeaponSnap { id: string; name: string; glyph: string; ammo: number; maxAmmo: number; cdFrac: number; lockFrac: number; locked: boolean; firing: boolean }
export interface SystemSnap { id: string; short: string; glyph: string; active: boolean; charges: number; maxCharges: number; passive: boolean }

export interface Snap {
  t: number; countdown: number; score: number; over: boolean
  hp: number; maxHp: number; battery: number; energyWh: number; powerW: number; minutesLeft: number
  speed: number; airspeed: number; agl: number; alt: number; vs: number; heading: number
  mode: 'hover' | 'cruise'; assist: boolean; throttle: number; kind: string; landed: boolean
  objective: { label: string; detail: string; done: number; total: number }
  timeLeft: number
  weapons: WeaponSnap[]; systems: SystemSnap[]
  warnings: string[]; feed: FeedItem[]; flash: Game['flash']
  aimDist: number; aimOnTarget: boolean
  wind: number; windRel: number
  thermal: boolean; hurtAgo: number
  lidarContacts: number; lidarOn: boolean
  version: number
  carried: number | null; pods: number
  thrustFrac: number
}

const PASSIVE = new Set(['stealth', 'parachute', 'winch'])

export function snapshot(g: Game): Snap {
  const c = g.craft
  const heading = c.heading()
  const wind = g.world.wind
  const windDir = (Math.atan2(wind.x, -wind.z) * 180) / Math.PI
  return {
    t: g.t, countdown: g.countdown, score: g.score, over: g.over,
    hp: Math.max(0, c.hp), maxHp: c.p.hp, battery: c.battery, energyWh: c.energyWh, powerW: c.powerW,
    minutesLeft: c.powerW > 1 ? (c.energyWh / c.powerW) * 60 : Infinity,
    speed: c.speed, airspeed: c.mode === 'cruise' ? c.airspeed : c.speed, agl: c.agl(g.world), alt: c.pos.y, vs: c.vel.y, heading,
    mode: c.mode, assist: c.assist, throttle: c.throttle, kind: c.p.kind, landed: c.landed,
    objective: g.objective(), timeLeft: g.timeLeft,
    weapons: g.weapons.map(w => {
      const s = w.def.stats as Record<string, number>
      const cdMax = w.def.id === 'emp' ? s.cooldownS : w.def.id === 'kinetic' ? 1 / s.rate : 1
      return {
        id: w.def.id, name: w.def.short, glyph: w.def.glyph, ammo: w.ammo, maxAmmo: w.maxAmmo, cdFrac: cdMax ? w.cd / cdMax : 0,
        lockFrac: w.def.id === 'missile' && w.lockTarget ? Math.min(1, w.lockT / s.lockS) : 0, locked: w.def.id === 'missile' && !!w.lockTarget && w.lockT >= s.lockS, firing: w.firing,
      }
    }),
    systems: g.systems.map(s => ({ id: s.def.id, short: s.def.short, glyph: s.def.glyph, active: s.active, charges: s.charges, maxCharges: s.maxCharges, passive: PASSIVE.has(s.def.id) })),
    warnings: g.warnings(), feed: [...g.feed], flash: g.flash,
    aimDist: g.aim.dist, aimOnTarget: !!g.aim.entity,
    wind: wind.length(), windRel: ((windDir - heading + 540) % 360) - 180,
    thermal: g.sysOn('thermal'), hurtAgo: g.t - g.hurtT,
    lidarContacts: g.lidar?.contacts ?? 0, lidarOn: !!g.lidar?.on,
    version: g.version, carried: g.carried?.mass ?? null, pods: g.pods,
    thrustFrac: c.p.Tmax > 0 ? c.thrustN / c.p.Tmax : 0,
  }
}

// ───────────────────────────── per-frame DOM ─────────────────────────────

export interface HudRefs {
  compass: HTMLDivElement | null
  markers: HTMLDivElement | null
  popups: HTMLDivElement | null
  lock: HTMLDivElement | null
  ccip: HTMLDivElement | null
  arrow: HTMLDivElement | null
  hurt: HTMLDivElement | null
  map: HTMLCanvasElement | null
  mapImg: HTMLCanvasElement | null
  mapClock: number
  mapRange: number
}

export const newHudRefs = (): HudRefs => ({ compass: null, markers: null, popups: null, lock: null, ccip: null, arrow: null, hurt: null, map: null, mapImg: null, mapClock: 0, mapRange: 300 })

const _v = new THREE.Vector3(), _w = new THREE.Vector3()
function toScreen(p: THREE.Vector3, cam: THREE.Camera, w: number, h: number): { x: number; y: number; front: boolean } {
  _v.copy(p).applyMatrix4(cam.matrixWorldInverse)
  const front = _v.z < 0
  _w.copy(p).project(cam)
  return { x: ((_w.x + 1) / 2) * w, y: ((1 - _w.y) / 2) * h, front }
}

function pool(container: HTMLDivElement, n: number, cls: string) {
  while (container.children.length < n) {
    const d = document.createElement('div')
    d.className = cls
    d.appendChild(document.createElement('span'))
    container.appendChild(d)
  }
  return container.children as HTMLCollectionOf<HTMLDivElement>
}

const MARK: Record<string, string> = { hostile: 'mk hostile', rogue: 'mk rogue', target: 'mk target', balloon: 'mk target', crate: 'mk crate' }

export function updateHudFrame(g: Game, cam: THREE.Camera, w: number, h: number, r: HudRefs, dt: number) {
  const c = g.craft
  if (r.compass) r.compass.style.transform = `translateX(${-c.heading() * 3}px)`
  if (r.hurt) r.hurt.style.opacity = String(Math.max(0, 1 - (g.t - g.hurtT) / 0.7) * 0.85)

  // markers
  if (r.markers) {
    const items: { p: THREE.Vector3; cls: string; label: string }[] = []
    for (const e of g.entities) {
      if (e.state !== 'active' || e.kind === 'micro') continue
      const d = e.pos.distanceTo(c.pos)
      if (e.kind === 'crate') { if (d < 400 && !e.carried) items.push({ p: e.pos, cls: 'mk crate', label: `${e.mass!.toFixed(2)} kg · ${d.toFixed(0)} m` }); continue }
      if (!e.seen) continue
      items.push({ p: e.pos, cls: `${MARK[e.kind] ?? 'mk'}${e.painted > 0 ? ' painted' : ''}`, label: `${d.toFixed(0)} m` })
    }
    for (const p of g.pads) items.push({ p: _padTop(p.pos), cls: 'mk pad', label: `PAD ${p.pos.distanceTo(c.pos).toFixed(0)} m` })
    for (const z of g.zones) if (!z.done) items.push({ p: _padTop(z.pos, 4), cls: 'mk zone', label: `ZONE ${Math.round(z.progress * 100)}%` })
    const ring = g.rings[g.nextRing]
    if (ring) items.push({ p: ring.pos, cls: 'mk ring', label: `${g.nextRing + 1}/${g.rings.length} · ${ring.pos.distanceTo(c.pos).toFixed(0)} m` })
    const els = pool(r.markers, items.length, 'mk')
    let n = 0
    for (const it of items) {
      const s = toScreen(it.p, cam, w, h)
      if (!s.front || s.x < -40 || s.x > w + 40 || s.y < -40 || s.y > h + 40) continue
      const el = els[n++]
      el.className = it.cls
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`
      el.style.display = ''
      const sp = el.firstChild as HTMLSpanElement
      if (sp.textContent !== it.label) sp.textContent = it.label
    }
    for (let i = n; i < els.length; i++) els[i].style.display = 'none'
  }

  // objective arrow when the next objective is off screen
  if (r.arrow) {
    const op = g.objectivePoint()
    let show = false
    if (op) {
      const s = toScreen(op, cam, w, h)
      const on = s.front && s.x > 30 && s.x < w - 30 && s.y > 30 && s.y < h - 30
      if (!on) {
        let dx = s.x - w / 2, dy = s.y - h / 2
        if (!s.front) { dx = -dx; dy = -dy }
        const a = Math.atan2(dy, dx)
        const rx = w / 2 - 70, ry = h / 2 - 90
        r.arrow.style.transform = `translate(${(w / 2 + Math.cos(a) * rx).toFixed(0)}px, ${(h / 2 + Math.sin(a) * ry).toFixed(0)}px) rotate(${a}rad)`
        show = true
      }
    }
    r.arrow.style.display = show ? '' : 'none'
  }

  // missile lock box
  if (r.lock) {
    const m = g.weapons.find(x => x.def.id === 'missile')
    const t = m?.lockTarget
    if (m && t && t.state === 'active') {
      const s = toScreen(t.pos, cam, w, h)
      const lockS = (m.def.stats as Record<string, number>).lockS
      const frac = Math.min(1, m.lockT / lockS)
      r.lock.style.display = s.front ? '' : 'none'
      r.lock.style.transform = `translate(${s.x.toFixed(0)}px, ${s.y.toFixed(0)}px) scale(${(1.8 - frac * 0.8).toFixed(2)})`
      r.lock.className = `lockbox${frac >= 1 ? ' locked' : ''}`
    } else r.lock.style.display = 'none'
  }

  // bomb sight: where a bomb (or pod) released now would land
  if (r.ccip) {
    const bombs = g.weapons.find(x => x.def.id === 'bomb' && x.ammo > 0)
    if (bombs || g.pods > 0) {
      const p = c.pos.clone(), v = c.vel.clone()
      let hit: THREE.Vector3 | null = null
      for (let i = 0; i < 600; i++) {
        v.y -= G * 0.04; v.multiplyScalar(1 - 0.02 * 0.04)
        p.addScaledVector(v, 0.04)
        if (p.y < groundAt(g.world, p.x, p.z)) { hit = p; break }
      }
      if (hit) {
        const s = toScreen(hit, cam, w, h)
        r.ccip.style.display = s.front ? '' : 'none'
        r.ccip.style.transform = `translate(${s.x.toFixed(0)}px, ${s.y.toFixed(0)}px)`
      } else r.ccip.style.display = 'none'
    } else r.ccip.style.display = 'none'
  }

  // floating score popups
  if (r.popups) {
    const els = pool(r.popups, g.popups.length, 'pop')
    let n = 0
    for (const p of g.popups) {
      const s = toScreen(p.pos, cam, w, h)
      if (!s.front) continue
      const el = els[n++]
      el.className = `pop ${p.kind}`
      el.style.display = ''
      el.style.opacity = String(Math.min(1, (1.6 - p.age) * 1.5))
      el.style.transform = `translate(${s.x.toFixed(0)}px, ${s.y.toFixed(0)}px) scale(${(1 + Math.max(0, 0.3 - p.age) * 2).toFixed(2)})`
      const sp = el.firstChild as HTMLSpanElement
      if (sp.textContent !== p.text) sp.textContent = p.text
    }
    for (let i = n; i < els.length; i++) els[i].style.display = 'none'
  }

  // minimap at ~20 Hz
  r.mapClock -= dt
  if (r.map && r.mapImg && r.mapClock <= 0) { r.mapClock = 0.05; drawMinimap(g, r.map, r.mapImg, r.mapRange) }
}

const _padTop = (p: THREE.Vector3, up = 1.5) => new THREE.Vector3(p.x, p.y + up, p.z)

// ───────────────────────────── minimap ─────────────────────────────

/** Top-down map of the static world, 2 m per pixel. */
export function makeMapImage(w: World): HTMLCanvasElement {
  const S = 800, k = S / (w.half * 2)
  const c = document.createElement('canvas'); c.width = c.height = S
  const g = c.getContext('2d')!
  const id = w.env.id
  g.fillStyle = id === 'forest' ? '#1f3020' : id === 'range' ? '#3b3226' : id === 'harbor' ? '#173447' : '#1e2329'
  g.fillRect(0, 0, S, S)
  const X = (x: number) => (x + w.half) * k
  if (id === 'harbor') { g.fillStyle = '#3a3a36'; g.fillRect(0, 0, X(-40), S) }
  if (id === 'range' || id === 'forest') {
    // contour-ish shading from height
    const img = g.getImageData(0, 0, S, S)
    for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
      const h = w.height(x / k - w.half, y / k - w.half)
      const v = Math.max(-30, Math.min(30, h)) * 1.2
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y + dy) * S + x + dx) * 4
        img.data[i] += v; img.data[i + 1] += v; img.data[i + 2] += v * 0.8
      }
    }
    g.putImageData(img, 0, 0)
  }
  g.fillStyle = id === 'night' ? '#3c4250' : '#5b636e'
  for (const b of w.buildings) g.fillRect(X(b.min.x), X(b.min.z), (b.max.x - b.min.x) * k, (b.max.z - b.min.z) * k)
  for (const b of w.boxes) { g.fillStyle = b.color; g.globalAlpha = 0.8; g.fillRect(X(b.min.x), X(b.min.z), Math.max(1, (b.max.x - b.min.x) * k), Math.max(1, (b.max.z - b.min.z) * k)) }
  g.globalAlpha = 1
  g.fillStyle = id === 'forest' ? '#2f5a2c' : '#6b6a3d'
  for (const t of w.trees) { g.beginPath(); g.arc(X(t.x), X(t.z), Math.max(0.8, t.r * k), 0, Math.PI * 2); g.fill() }
  return c
}

function drawMinimap(g: Game, cv: HTMLCanvasElement, img: HTMLCanvasElement, range: number) {
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const W = cv.width, R = W / 2
  const c = g.craft
  const f = c.forward()
  const theta = Math.atan2(f.z, f.x)
  const rot = -Math.PI / 2 - theta
  const s = R / range
  ctx.clearRect(0, 0, W, W)
  ctx.save()
  ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.clip()
  ctx.fillStyle = '#0b1219'; ctx.fillRect(0, 0, W, W)
  ctx.translate(R, R); ctx.rotate(rot); ctx.scale(s, s); ctx.translate(-c.pos.x, -c.pos.z)
  ctx.globalAlpha = 0.9
  ctx.drawImage(img, -g.world.half, -g.world.half, g.world.half * 2, g.world.half * 2)
  ctx.globalAlpha = 1
  const dot = (x: number, z: number, r: number, col: string, ring = false) => {
    ctx.beginPath(); ctx.arc(x, z, r / s, 0, Math.PI * 2)
    if (ring) { ctx.strokeStyle = col; ctx.lineWidth = 1.6 / s; ctx.stroke() } else { ctx.fillStyle = col; ctx.fill() }
  }
  for (const z of g.zones) { dot(z.pos.x, z.pos.z, Math.max(z.radius * s, 5), z.done ? '#3fd69b' : '#5cb3ff', true) }
  for (const p of g.pads) { ctx.fillStyle = '#3fd69b'; ctx.fillRect(p.pos.x - 4 / s, p.pos.z - 4 / s, 8 / s, 8 / s) }
  g.rings.forEach((r, i) => { if (!r.passed) dot(r.pos.x, r.pos.z, i === g.nextRing ? 5 : 3, i === g.nextRing ? '#ff6a2b' : '#ffffff', i !== g.nextRing) })
  if (g.rings.length) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1 / s; ctx.setLineDash([4 / s, 4 / s]); ctx.beginPath()
    g.rings.slice(g.nextRing).forEach((r, i) => (i ? ctx.lineTo(r.pos.x, r.pos.z) : ctx.moveTo(r.pos.x, r.pos.z)))
    ctx.stroke(); ctx.setLineDash([])
  }
  for (const e of g.entities) {
    if (e.state !== 'active') continue
    if (e.kind === 'micro') { dot(e.pos.x, e.pos.z, 2.5, '#38d39f'); continue }
    if (e.kind === 'crate') { ctx.fillStyle = '#f2e3c4'; ctx.fillRect(e.pos.x - 3 / s, e.pos.z - 3 / s, 6 / s, 6 / s); continue }
    if (!e.seen) continue
    dot(e.pos.x, e.pos.z, e.kind === 'target' ? 3.5 : 3, e.kind === 'hostile' ? '#ff4d5e' : e.kind === 'rogue' ? '#f6c344' : e.painted > 0 ? '#ff5cf0' : '#ff9a52')
  }
  ctx.restore()
  // radar sweep
  if (g.sysOn('radar')) {
    const a = (performance.now() / 1000) * 2.5
    const grd = ctx.createConicGradient ? ctx.createConicGradient(a, R, R) : null
    if (grd) {
      grd.addColorStop(0, 'rgba(63,214,155,0.28)'); grd.addColorStop(0.12, 'rgba(63,214,155,0)'); grd.addColorStop(1, 'rgba(63,214,155,0)')
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.fill()
    }
  }
  // range rings
  ctx.strokeStyle = 'rgba(160,190,220,0.18)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(R, R, R / 2, 0, Math.PI * 2); ctx.stroke()
  // own ship
  ctx.fillStyle = '#ff6a2b'
  ctx.beginPath(); ctx.moveTo(R, R - 8); ctx.lineTo(R + 5.5, R + 6); ctx.lineTo(R, R + 3); ctx.lineTo(R - 5.5, R + 6); ctx.closePath(); ctx.fill()
  // north tick
  const na = rot - Math.PI / 2
  ctx.fillStyle = '#e7eef6'; ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('N', R + Math.cos(na) * (R - 10), R + Math.sin(na) * (R - 10))
}

// ───────────────────────────── React HUD ─────────────────────────────

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const KEYS_W = ['F', 'R']
const KEYS_S = ['1', '2']

export function Hud({ s, refs, game, mission, missionGlyph, onPause, input, touch, help, onHelp, onAction, camMode }: {
  s: Snap; refs: RefObject<HudRefs>; game: Game; mission: string; missionGlyph: string; onPause: () => void
  input: InputManager; touch: boolean; help: boolean; onHelp: (v: boolean) => void; onAction: (a: 'sys1' | 'sys2' | 'hook' | 'transition' | 'camera' | 'assist') => void; camMode: string
}) {
  const mapImg = useMemo(() => makeMapImage(game.world), [game.world])
  useEffect(() => { if (refs.current) refs.current.mapImg = mapImg }, [mapImg, refs])
  const set = <K extends keyof HudRefs>(k: K) => (el: HudRefs[K]) => { if (refs.current) refs.current[k] = el }
  const o = s.objective
  const hpF = s.hp / Math.max(s.maxHp, 1)
  const isWing = s.mode === 'cruise'
  const timer = Number.isFinite(s.timeLeft) ? fmtT(s.timeLeft) : fmtT(s.t)
  const flashAge = s.flash ? s.t - s.flash.t : 99
  return (
    <div className="hud">
      <div className="hud-hurt" ref={set('hurt')} />
      {s.thermal && <div className="hud-thermal-tag">THERMAL · WHITE-HOT</div>}

      <div className="hud-tl hud-panel">
        <div className="hud-mission"><span className="hud-glyph">{missionGlyph}</span>{mission}</div>
        <div className="hud-obj">
          <b>{o.label}</b>{o.total > 0 && <span className="mono"> {o.done}/{o.total}</span>}
          <div className="hud-obj-detail">{o.detail}</div>
          {o.total > 0 && <div className="hud-prog"><i style={{ width: `${(o.done / o.total) * 100}%` }} /></div>}
        </div>
        <div className="hud-score-row">
          <div><div className="hud-lbl">Score</div><div className="hud-score">{s.score.toLocaleString()}</div></div>
          <div style={{ textAlign: 'right' }}><div className="hud-lbl">{Number.isFinite(s.timeLeft) ? 'Time left' : 'Elapsed'}</div><div className={`hud-time${Number.isFinite(s.timeLeft) && s.timeLeft < 15 ? ' urgent' : ''}`}>{timer}</div></div>
        </div>
      </div>

      <div className="hud-tc">
        <div className="hud-compass"><div className="hud-tape" ref={set('compass')}>{COMPASS}</div><i className="hud-caret" /></div>
        <div className="hud-hdg mono">{String(Math.round(s.heading) % 360).padStart(3, '0')}°</div>
      </div>

      <div className="hud-tr">
        <canvas ref={set('map')} width={176} height={176} className="hud-map" onClick={() => { if (refs.current) refs.current.mapRange = refs.current.mapRange === 300 ? 700 : refs.current.mapRange === 700 ? 150 : 300 }} />
        <div className="hud-wind mono" title="Wind relative to your heading">
          <span style={{ display: 'inline-block', transform: `rotate(${s.windRel + 180}deg)` }}>↑</span> {s.wind.toFixed(1)} m/s
        </div>
      </div>

      <div className="hud-l">
        <div className="hud-big"><span className="mono">{s.airspeed.toFixed(1)}</span><small>m/s</small></div>
        <div className="hud-sub mono">{(s.airspeed * 3.6).toFixed(0)} km/h</div>
        <div className="hud-big" style={{ marginTop: 10 }}><span className="mono">{s.agl.toFixed(1)}</span><small>m AGL</small></div>
        <div className={`hud-sub mono ${s.vs > 0.3 ? 'up' : s.vs < -0.3 ? 'down' : ''}`}>{s.vs >= 0 ? '▲' : '▼'} {Math.abs(s.vs).toFixed(1)} m/s</div>
      </div>

      <div className="hud-bl hud-panel">
        <div className="hud-bar-row"><span className="hud-lbl">Hull</span><div className="hud-bar"><i style={{ width: `${hpF * 100}%`, background: hpF < 0.25 ? 'var(--bad)' : hpF < 0.5 ? 'var(--warn)' : 'var(--ok)' }} /></div><span className="mono small">{Math.ceil(s.hp)}</span></div>
        <div className="hud-bar-row"><span className="hud-lbl">Battery</span><div className="hud-bar"><i style={{ width: `${s.battery * 100}%`, background: s.battery < 0.15 ? 'var(--bad)' : s.battery < 0.3 ? 'var(--warn)' : 'var(--info)' }} /></div><span className="mono small">{Math.round(s.battery * 100)}%</span></div>
        <div className="hud-stats mono">
          <span>{s.powerW.toFixed(0)} W</span>
          <span>{Number.isFinite(s.minutesLeft) ? `${s.minutesLeft.toFixed(1)} min left` : '—'}</span>
          {isWing ? <span>THR {(s.throttle * 100).toFixed(0)}%</span> : <span>THR {(s.thrustFrac * 100).toFixed(0)}%</span>}
        </div>
        <div className="hud-chips">
          {s.kind !== 'wing' && <button className={`hud-chip ${s.assist ? 'on' : ''}`} onClick={() => onAction('assist')}>{s.assist ? 'ASSIST' : 'ANGLE'} <kbd>M</kbd></button>}
          {s.kind === 'vtol' && <button className={`hud-chip ${s.mode === 'cruise' ? 'on' : ''}`} onClick={() => onAction('transition')}>{s.mode === 'cruise' ? 'WING' : 'HOVER'} <kbd>T</kbd></button>}
          <button className="hud-chip" onClick={() => onAction('camera')}>{camMode.toUpperCase()} <kbd>C</kbd></button>
          {s.carried != null && <span className="hud-chip on">CARGO {s.carried.toFixed(2)} kg</span>}
          {s.pods > 0 && <span className="hud-chip on">PODS {s.pods}</span>}
          {s.lidarOn && <span className="hud-chip">LIDAR {s.lidarContacts > 0.5 ? `· ${s.lidarContacts.toFixed(0)} hits` : ''}</span>}
        </div>
      </div>

      <div className="hud-bc">
        {s.weapons.map((w, i) => (
          <div key={w.id + i} className={`hud-slot weapon ${w.firing ? 'firing' : ''} ${w.ammo <= 0 ? 'empty' : ''} ${w.locked ? 'locked' : ''}`}>
            <div className="hud-slot-glyph">{w.glyph}</div>
            <div className="hud-slot-body">
              <div className="hud-slot-name">{w.name}</div>
              <div className="mono hud-slot-ammo">{Number.isFinite(w.ammo) ? `${w.ammo}/${w.maxAmmo}` : w.id === 'emp' ? (w.cdFrac > 0 ? 'charging' : 'ready') : '∞'}{w.id === 'missile' && w.lockFrac > 0 ? ` · ${w.locked ? 'LOCK' : `${Math.round(w.lockFrac * 100)}%`}` : ''}</div>
            </div>
            <kbd>{touch ? `W${i + 1}` : KEYS_W[i]}</kbd>
            {w.cdFrac > 0 && <i className="hud-slot-cd" style={{ width: `${Math.min(1, w.cdFrac) * 100}%` }} />}
          </div>
        ))}
        {s.systems.map((y, i) => (
          <button key={y.id + i} className={`hud-slot system ${y.active ? 'on' : ''} ${y.passive ? 'passive' : ''}`} onClick={() => onAction(i === 0 ? 'sys1' : 'sys2')}>
            <div className="hud-slot-glyph">{y.glyph}</div>
            <div className="hud-slot-body">
              <div className="hud-slot-name">{y.short}</div>
              <div className="mono hud-slot-ammo">{Number.isFinite(y.charges) ? `${y.charges} left` : y.passive ? 'passive' : y.active ? 'on' : 'off'}</div>
            </div>
            <kbd>{KEYS_S[i]}</kbd>
          </button>
        ))}
        {game.mission.id === 'delivery' && <button className="hud-slot system" onClick={() => onAction('hook')}><div className="hud-slot-glyph">⚓</div><div className="hud-slot-body"><div className="hud-slot-name">{s.pods > 0 ? 'Drop pod' : s.carried != null ? 'Release' : 'Hook'}</div><div className="mono hud-slot-ammo">{game.hookReach} m reach</div></div><kbd>B</kbd></button>}
      </div>

      <div className="hud-r">
        {s.feed.slice().reverse().map((f, i) => (
          <div key={`${f.t}-${i}`} className={`hud-feed ${f.kind}`} style={{ opacity: Math.max(0.25, 1 - (s.t - f.t) / 12) }}>
            {f.pts ? <b className="mono">+{f.pts}</b> : null} {f.text}
          </div>
        ))}
      </div>

      <div className="hud-reticle">
        <svg width="64" height="64" viewBox="-32 -32 64 64" className={s.aimOnTarget ? 'on' : ''}>
          <circle r="13" fill="none" strokeWidth="1.5" />
          <path d="M-24 0h8M16 0h8M0 -24v8M0 16v8" strokeWidth="1.5" />
          <circle r="1.6" stroke="none" />
        </svg>
        <div className="hud-range mono">{s.aimDist < 799 ? `${s.aimDist.toFixed(0)} m` : '— m'}</div>
      </div>
      <div className="hud-markers" ref={set('markers')} />
      <div className="hud-popups" ref={set('popups')} />
      <div className="lockbox" ref={set('lock')} style={{ display: 'none' }} />
      <div className="ccip" ref={set('ccip')} style={{ display: 'none' }}><i /></div>
      <div className="obj-arrow" ref={set('arrow')} style={{ display: 'none' }}>➤</div>

      {s.warnings.length > 0 && <div className="hud-warn">{s.warnings.map(w => <span key={w}>{w}</span>)}</div>}
      {s.flash && flashAge < 2.2 && <div key={s.flash.t} className={`hud-flash ${s.flash.kind}`}>{s.flash.text}</div>}
      {s.countdown > 0 && <div key={Math.ceil(s.countdown)} className="hud-count">{Math.ceil(s.countdown)}</div>}

      <button className="hud-pause" onClick={onPause} aria-label="Pause">❚❚</button>
      {!touch && !help && <div className="hud-hint">H · controls &nbsp;·&nbsp; click to aim with the mouse &nbsp;·&nbsp; P · pause</div>}
      {help && <HelpOverlay kind={s.kind} onClose={() => onHelp(false)} />}
      {touch && <TouchControls input={input} weapons={s.weapons.length} />}
    </div>
  )
}

const COMPASS = (() => {
  const out = []
  for (let d = -180; d <= 540; d += 15) {
    const n = ((d % 360) + 360) % 360
    const lbl = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : n % 45 === 0 ? String(n) : ''
    out.push(<span key={d} className={`hud-tick ${lbl.length === 1 ? 'cardinal' : ''}`} style={{ left: `${(d + 180) * 3}px` }}>{lbl || '|'}</span>)
  }
  return <>{out}</>
})()

export function HelpOverlay({ kind, onClose }: { kind: string; onClose: () => void }) {
  const wing = kind === 'wing'
  const rows: [string, string][] = wing ? [
    ['W / S', 'Nose down / up'], ['A / D', 'Roll left / right'], ['Q / E', 'Rudder'], ['Space / Shift', 'Throttle up / down'],
  ] : [
    ['W / S', 'Forward / back'], ['A / D', 'Slide left / right'], ['Q / E or ← →', 'Turn'], ['Space / Shift', 'Climb / descend'], ['M', 'Assist (velocity) ↔ angle mode'],
  ]
  rows.push(['Mouse (click to capture)', 'Look up/down to aim · sideways to turn'], ['↑ / ↓', 'Tilt the gimbal'], ['F · left click', 'Weapon 1'], ['R · right click', 'Weapon 2'],
    ['1 / 2', 'System 1 / 2'], ['B', 'Hook / release cargo · drop pod'], ['T', 'VTOL: hover ↔ wing'], ['C', 'Camera: chase · FPV · orbit'], ['N / click map', 'Map zoom'], ['P / Esc', 'Pause'], ['Backspace', 'Restart'])
  return (
    <div className="hud-help" onClick={onClose}>
      <div className="hud-help-card" onClick={e => e.stopPropagation()}>
        <div className="row"><h3 style={{ margin: 0 }}>Controls</h3><button className="btn sm right" onClick={onClose}>Got it</button></div>
        <div className="hud-help-grid">{rows.map(([k, v]) => <div key={k} className="contents"><kbd>{k}</kbd><span>{v}</span></div>)}</div>
        <p className="tiny faint" style={{ margin: '10px 0 0' }}>Gamepads work too: left stick throttle + yaw, right stick pitch + roll, triggers fire, A/B systems, X hook, Y camera.</p>
      </div>
    </div>
  )
}

function Stick({ onMove, label }: { onMove: (x: number, y: number) => void; label: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const base = useRef<HTMLDivElement>(null)
  const id = useRef<number | null>(null)
  const move = (e: React.PointerEvent) => {
    if (id.current !== e.pointerId || !base.current) return
    const r = base.current.getBoundingClientRect()
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l }
    setPos({ x, y }); onMove(x, y)
  }
  return (
    <div ref={base} className="stick" onPointerDown={e => { id.current = e.pointerId; (e.target as HTMLElement).setPointerCapture(e.pointerId); move(e) }}
      onPointerMove={move} onPointerUp={() => { id.current = null; setPos(null); onMove(0, 0) }} onPointerCancel={() => { id.current = null; setPos(null); onMove(0, 0) }}>
      <i style={{ transform: `translate(${(pos?.x ?? 0) * 34}px, ${(pos?.y ?? 0) * 34}px)` }} />
      <span>{label}</span>
    </div>
  )
}

function TouchControls({ input, weapons }: { input: InputManager; weapons: number }) {
  useEffect(() => { input.touch.active = true; return () => { input.touch.active = false } }, [input])
  return (
    <div className="touch">
      <Stick label="THR · YAW" onMove={(x, y) => { input.touch.lx = x; input.touch.ly = y }} />
      <div className="touch-fire">
        {Array.from({ length: weapons }, (_, i) => (
          <button key={i} className="touch-btn" onPointerDown={() => { if (i === 0) input.touch.fire1 = true; else input.touch.fire2 = true }}
            onPointerUp={() => { if (i === 0) input.touch.fire1 = false; else input.touch.fire2 = false }} onPointerLeave={() => { if (i === 0) input.touch.fire1 = false; else input.touch.fire2 = false }}>W{i + 1}</button>
        ))}
      </div>
      <Stick label="PITCH · ROLL" onMove={(x, y) => { input.touch.rx = x; input.touch.ry = y }} />
    </div>
  )
}
