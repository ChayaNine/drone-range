/**
 * The simulator screen. Loads the drone, then runs the physics at a fixed 120 Hz under a
 * frame-rate render, with HUD, pause and results. All the rules live in ../sim/game.ts; this file
 * is the glue between that engine, three.js, the input devices and the screen.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import { tuneRenderer } from '../components/three/perf'
import { useLibrary } from '../lib/library'
import { computePerformance } from '../engine/performance'
import { buildGeometry } from '../engine/geometry'
import type { DroneSpec } from '../engine/types'
import { Game, type RunResult } from '../sim/game'
import { groundAt } from '../sim/world'
import { InputManager, type Action } from '../sim/input'
import { SimAudio } from '../sim/audio'
import { dailyChallenge, envById, missionById, missionKey, type EnvDef, type MissionDef, type Twist } from '../sim/catalog'
import { EntityLayer, Effects, GroundShadow, LaserBeam, Lamps, LaunchPad, LidarCloud, Lights, Objectives, Player, Projectiles, Rope, Searchlight, Sky, Structures, Terrain, Trees } from '../sim/Scene'
import { Hud, newHudRefs, snapshot, updateHudFrame, type HudRefs, type Snap } from '../sim/Hud'
import { readJSON, writeJSON } from '../lib/storage'
import { recordRun, type RunRecord } from '../lib/scores'
import { STORAGE_PREFIX } from '../config'
import { sfx } from '../lib/sound'
import '../sim/hud.css'

type CamMode = 'chase' | 'fpv' | 'orbit'
interface Quality { shadows: boolean; dpr: number }

export default function Flight() {
  const { droneId = '', env = 'range', mission = 'free' } = useParams()
  const [sp] = useSearchParams()
  const drone = useLibrary(s => s.find(droneId))
  if (!drone) return (
    <div className="sim-gate">
      <h2>That drone isn't in your library</h2>
      <p className="muted">It may have been removed, or the link came from another browser.</p>
      <Link className="btn primary" to="/">Pick a drone</Link>
    </div>
  )
  const daily = sp.get('daily') ? dailyChallenge() : null
  const twist: Twist | null = daily ? daily.twist : null
  const wind = sp.get('wind')
  return <FlightRun spec={drone.spec} envDef={envById(env)} missionDef={missionById(mission)} twist={twist} dailyKey={daily?.key ?? null} wind={wind != null ? Number(wind) : undefined} />
}

function FlightRun({ spec, envDef, missionDef, twist, dailyKey, wind }: { spec: DroneSpec; envDef: EnvDef; missionDef: MissionDef; twist: Twist | null; dailyKey: string | null; wind?: number }) {
  const nav = useNavigate()
  const perf = useMemo(() => computePerformance(spec), [spec])
  const geo = useMemo(() => buildGeometry(spec), [spec])
  const [run, setRun] = useState(0)
  const night = !!(envDef.night || twist?.night)
  const game = useMemo(() => new Game({
    spec, perf, geo, env: envDef, mission: missionDef, seed: 7 + (dailyKey ? dailyKey.length : 0),
    wind: twist?.wind ?? wind, battery: twist?.battery, night,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [run])
  const input = useMemo(() => new InputManager(), [])
  const audio = useRef<SimAudio | null>(null)
  const hudRefs = useRef<HudRefs>(newHudRefs())
  const [snap, setSnap] = useState<Snap>(() => snapshot(game))
  const [cam, setCam] = useState<CamMode>('chase')
  const [paused, setPaused] = useState(false)
  const [help, setHelp] = useState(() => !readJSON<boolean>(`${STORAGE_PREFIX}simHelpSeen`, false))
  const [quality, setQuality] = useState<Quality>(() => readJSON<Quality>(`${STORAGE_PREFIX}simq`, { shadows: !(navigator.hardwareConcurrency <= 4 || matchMedia('(pointer: coarse)').matches), dpr: 1.5 }))
  const touch = useMemo(() => matchMedia('(pointer: coarse)').matches, [])
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => { writeJSON(`${STORAGE_PREFIX}simq`, quality) }, [quality])
  useEffect(() => { if (!help) writeJSON(`${STORAGE_PREFIX}simHelpSeen`, true) }, [help])
  useEffect(() => { game.paused = paused || help; if (paused) input.releasePointer() }, [paused, help, game, input])

  // audio lives as long as the page
  useEffect(() => {
    const a = new SimAudio(game.craft.p.kind, game.span)
    audio.current = a
    return () => { a.dispose(); audio.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    game.onSound = (k, pos, gain) => audio.current?.play(k, pos ? pos.distanceTo(game.craft.pos) : 0, gain ?? 1)
  }, [game])

  const restart = useCallback(() => { setRun(r => r + 1); setPaused(false); sfx.click() }, [])
  const onAction = useCallback((a: Action) => {
    if (a === 'pause') { if (!game.over) setPaused(p => !p); return }
    if (a === 'help') { setHelp(h => !h); return }
    if (a === 'restart') { restart(); return }
    if (a === 'camera') { setCam(c => (c === 'chase' ? 'fpv' : c === 'fpv' ? 'orbit' : 'chase')); return }
    if (a === 'map') { const r = hudRefs.current; r.mapRange = r.mapRange === 300 ? 700 : r.mapRange === 700 ? 150 : 300; return }
    if (game.paused || game.over) return
    if (a === 'sys1') game.toggleSystem(0)
    else if (a === 'sys2') game.toggleSystem(1)
    else if (a === 'hook') game.hook()
    else if (a === 'transition') game.transition()
    else if (a === 'assist') { game.craft.assist = !game.craft.assist; game.say(game.craft.assist ? 'Assist: stick sets velocity' : 'Angle mode: stick sets tilt', 'info') }
  }, [game, restart])
  useEffect(() => { input.onAction = onAction }, [input, onAction])
  useEffect(() => {
    const el = wrap.current?.querySelector('canvas')
    if (!el) return
    input.attach(el)
    return () => input.detach()
  }, [input])

  // settle the run once
  const [after, setAfter] = useState<AfterRun | null>(null)
  const settled = useRef(-1)
  useEffect(() => {
    if (!snap.over || !game.result || settled.current === run) return
    settled.current = run
    input.releasePointer()
    setAfter(settle(game.result, { spec, envDef, missionDef, dailyKey }))
  }, [snap.over, game, run, input, spec, envDef, missionDef, dailyKey])
  useEffect(() => { setAfter(null); setSnap(snapshot(game)) }, [game])

  const top = night ? (envDef.night ? envDef.sky[0] : '#1b2440') : envDef.sky[0]
  const hor = night ? (envDef.night ? envDef.sky[1] : '#b8663a') : envDef.sky[1]
  const fogDensity = (twist?.fog ?? envDef.fog) * (snap.thermal ? 0.35 : 1)

  return (
    <div className="sim-root" ref={wrap}>
      <div className="sim-canvas" style={{ filter: snap.thermal ? 'grayscale(1) contrast(1.45) brightness(0.95)' : undefined }}>
        <Canvas shadows={quality.shadows ? 'percentage' : false} dpr={[1, quality.dpr]} gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 62, near: 0.05, far: 4200, position: [0, 3, 6] }} onCreated={({ gl }) => tuneRenderer(gl)}>
          <color attach="background" args={[hor]} />
          <fogExp2 attach="fog" args={[hor, fogDensity]} />
          <Suspense fallback={null}>
            <Sky top={top} horizon={hor} night={night} />
            <Lights game={game} night={night} thermal={snap.thermal} shadows={quality.shadows} />
            <Terrain world={game.world} night={!!envDef.night} />
            <Structures world={game.world} night={!!envDef.night} shadows={quality.shadows} />
            <Trees world={game.world} shadows={quality.shadows} />
            <Lamps world={game.world} game={game} />
            <LaunchPad at={game.world.spawn} size={Math.max(2.5, game.span * 2.2)} />
            <group key={run}>
              <Player game={game} spec={spec} geo={geo} visible={cam !== 'fpv'} />
              <GroundShadow game={game} />
              <Searchlight game={game} />
              <EntityLayer game={game} version={snap.version} thermal={snap.thermal} />
              <Projectiles game={game} />
              <Effects game={game} />
              <Objectives game={game} />
              <Rope game={game} />
              <LaserBeam game={game} />
              <LidarCloud game={game} />
            </group>
          </Suspense>
          {cam === 'orbit' && <OrbitControls makeDefault enablePan={false} maxDistance={200} minDistance={Math.max(game.span * 1.5, 0.6)} />}
          <SimLoop game={game} input={input} cam={cam} paused={paused || help} audio={audio} hud={hudRefs} onSnap={setSnap} />
        </Canvas>
      </div>

      <Hud s={snap} refs={hudRefs} game={game} mission={`${missionDef.name} · ${envDef.name}`} missionGlyph={missionDef.glyph} onPause={() => setPaused(true)}
        input={input} touch={touch} help={help} onHelp={setHelp} onAction={onAction} camMode={cam} />
      {twist && snap.t < 6 && <div className="sim-twist">Daily twist · {twist.label}</div>}

      {paused && !snap.over && (
        <div className="sim-scrim">
          <div className="sim-menu">
            <div className="eyebrow">Paused</div>
            <h2>{missionDef.name}</h2>
            <p className="muted small">{spec.name} · {envDef.name} · {perf.className}</p>
            <div className="col" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn primary lg" onClick={() => setPaused(false)}>Resume</button>
              <button className="btn" onClick={restart}>Restart</button>
              <button className="btn" onClick={() => { setPaused(false); setHelp(true) }}>Controls</button>
              <button className="btn" onClick={() => setCam(c => (c === 'chase' ? 'fpv' : c === 'fpv' ? 'orbit' : 'chase'))}>Camera: {cam}</button>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={quality.shadows} onChange={e => setQuality(q => ({ ...q, shadows: e.target.checked }))} /> Shadows</label>
                <label className="row small" style={{ gap: 6 }}>Sharpness
                  <select value={quality.dpr} onChange={e => setQuality(q => ({ ...q, dpr: Number(e.target.value) }))} className="input sm" style={{ width: 'auto' }}>
                    <option value={1}>Fast</option><option value={1.5}>Balanced</option><option value={2}>Crisp</option>
                  </select>
                </label>
              </div>
              <div className="divider" />
              <button className="btn" onClick={() => { setPaused(false); game.finish('quit'); setSnap(snapshot(game)) }}>End flight & see results</button>
              <button className="btn quiet" onClick={() => nav('/')}>Exit to mission select</button>
            </div>
          </div>
        </div>
      )}

      {snap.over && game.result && (
        <EndScreen result={game.result} after={after} mission={missionDef} env={envDef} 
          onRetry={restart} onExit={() => nav('/')} />
      )}
    </div>
  )
}

const STEP = 1 / 120
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _look = new THREE.Vector3()

function SimLoop({ game, input, cam, paused, audio, hud, onSnap }: {
  game: Game; input: InputManager; cam: CamMode; paused: boolean; audio: RefObject<SimAudio | null>; hud: RefObject<HudRefs>; onSnap: (s: Snap) => void
}) {
  const three = useThree()
  const acc = useRef(0)
  const camPos = useRef(new THREE.Vector3())
  const camInit = useRef(false)
  const lastCraft = useRef(new THREE.Vector3())
  const snapClock = useRef(0)
  const wasOver = useRef(false)
  useEffect(() => {
    const c = three.camera as THREE.PerspectiveCamera
    c.fov = cam === 'fpv' ? 92 : cam === 'orbit' ? 55 : 62
    c.near = Math.max(0.02, Math.min(0.1, game.span * 0.1))
    c.updateProjectionMatrix()
    camInit.current = false
    if (cam === 'orbit') {
      const p = game.craft.pos
      c.position.set(p.x - game.span * 4, p.y + game.span * 2, p.z + game.span * 4)
      lastCraft.current.copy(p)
    }
  }, [cam, three.camera, game])
  useEffect(() => { camInit.current = false; acc.current = 0 }, [game])

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1)
    const camera = state.camera as THREE.PerspectiveCamera
    const ctrl = input.read(dt)
    game.aimPitch = THREE.MathUtils.clamp(game.aimPitch + ctrl.aimDelta, -1.48, 0.55)
    if (!paused && !game.over) {
      acc.current += dt
      let n = 0
      while (acc.current >= STEP && n < 14) { game.update(STEP, ctrl.axes, ctrl.fire); acc.current -= STEP; n++ }
      if (n >= 14) acc.current = 0
      game.scanLidar()
    }

    // camera
    const c = game.craft
    const f = c.forward(_v)
    const yaw = Math.atan2(-f.z, f.x)
    const craftPitch = c.mode === 'cruise' ? Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)) : 0
    const pitch = THREE.MathUtils.clamp(game.aimPitch + craftPitch * 0.85, -1.5, 1.3)
    _d.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw))
    if (cam === 'chase') {
      const dist = THREE.MathUtils.clamp(game.span * 3.2, 1.6, 18) + Math.min(c.speed * 0.05, 3)
      const want = _look.copy(c.pos).addScaledVector(_d, -dist)
      want.y += dist * 0.3
      const g = groundAt(game.world, want.x, want.z)
      if (want.y < g + 0.35) want.y = g + 0.35
      if (!camInit.current) { camPos.current.copy(want); camInit.current = true }
      camPos.current.lerp(want, 1 - Math.exp(-dt * (c.mode === 'cruise' ? 11 : 7.5)))
      camera.position.copy(camPos.current)
      camera.up.set(0, 1, 0)
      _look.copy(c.pos).addScaledVector(_d, 30)
      camera.lookAt(_look)
      game.setAim(camera.position, _look.sub(camera.position))
    } else if (cam === 'fpv') {
      const p = game.bodyToWorld(new THREE.Vector3(game.span * 0.42, game.span * 0.06, 0))
      camera.position.copy(p)
      if (c.mode === 'cruise') camera.up.copy(c.up())
      else camera.up.set(0, 1, 0)
      camera.lookAt(_look.copy(p).add(_d))
      if (c.mode !== 'cruise') camera.rotateZ(-c.roll * 0.35)
      game.setAim(p, _d)
    } else {
      const controls = state.controls as unknown as OrbitControlsImpl | null
      camera.position.add(_look.subVectors(c.pos, lastCraft.current))
      lastCraft.current.copy(c.pos)
      if (controls) { controls.target.copy(c.pos); controls.update() }
      camera.getWorldDirection(_look)
      game.setAim(camera.position, _look)
    }

    audio.current?.update(c.p.Tmax > 0 ? c.thrustN / c.p.Tmax : 0, c.mode === 'cruise' ? c.airspeed : c.speed, game.laser.on, !paused && !game.over && c.alive && game.countdown <= 0)
    if (hud.current) updateHudFrame(game, camera, state.size.width, state.size.height, hud.current, dt)
    snapClock.current -= dt
    if (snapClock.current <= 0 || game.over !== wasOver.current) { wasOver.current = game.over; snapClock.current = 0.1; onSnap(snapshot(game)) }
  })
  return null
}

// ───────────────────────────── results ─────────────────────────────

interface AfterRun { newBest: boolean; prevBest: number | null; board: RunRecord[]; boardKey: string | null; at: string | null }

/** Saves the run to this browser's local scoreboard. Free flight is never scored. */
function settle(r: RunResult, ctx: { spec: DroneSpec; envDef: EnvDef; missionDef: MissionDef; dailyKey: string | null }): AfterRun {
  const boardKey = ctx.missionDef.id === 'free' ? null : ctx.dailyKey ?? missionKey(ctx.missionDef.id, ctx.envDef.id)
  if (!boardKey || r.score <= 0) return { newBest: false, prevBest: null, board: [], boardKey, at: null }
  const at = new Date().toISOString()
  const { newBest, prevBest, board } = recordRun(boardKey, { score: r.score, stars: r.stars, timeMs: r.timeMs, droneName: ctx.spec.name, at })
  return { newBest, prevBest, board, boardKey, at }
}

const REASON: Record<RunResult['reason'], string> = {
  complete: 'Mission complete', time: 'Time', destroyed: 'Airframe destroyed', battery: 'Battery depleted', quit: 'Flight ended',
}

function EndScreen({ result, after, mission, env, onRetry, onExit }: {
  result: RunResult; after: AfterRun | null; mission: MissionDef; env: EnvDef; onRetry: () => void; onExit: () => void
}) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (!result.stars) return
    let i = 0
    const t = setInterval(() => { i++; setShown(i); sfx.up(); if (i >= result.stars) clearInterval(t) }, 380)
    return () => clearInterval(t)
  }, [result.stars])
  const st = result.stats
  const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : null
  const good = result.completed && result.reason !== 'destroyed'
  return (
    <div className="sim-scrim">
      <div className="sim-end">
        <div className="eyebrow">{mission.name} · {env.name}</div>
        <h2 className={good ? '' : 'bad'}>{REASON[result.reason]}</h2>
        {mission.id !== 'free' && (
          <div className="sim-stars">{[0, 1, 2].map(i => <span key={i} className={i < shown ? 'on' : ''}>★</span>)}</div>
        )}
        <div className="sim-score mono">{result.score.toLocaleString()}</div>
        {after?.newBest && <div className="chip act" style={{ alignSelf: 'center' }}>New personal best{after.prevBest != null ? ` · was ${after.prevBest.toLocaleString()}` : ''}</div>}
        {mission.id !== 'free' && <div className="tiny faint" style={{ textAlign: 'center' }}>Stars at {mission.stars.map(s => s.toLocaleString()).join(' · ')}</div>}

        <div className="sim-end-grid">
          <div>
            <div className="eyebrow">Breakdown</div>
            <table className="tbl small"><tbody>
              {result.breakdown.length ? result.breakdown.map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono" style={{ textAlign: 'right' }}>{v.toLocaleString()}</td></tr>) : <tr><td className="faint">No points this run</td><td /></tr>}
            </tbody></table>
            <div className="eyebrow" style={{ marginTop: 12 }}>Flight</div>
            <div className="kv small">
              <span className="muted">Time</span><span className="mono">{(result.timeMs / 1000).toFixed(1)} s</span>
              <span className="muted">Distance</span><span className="mono">{st.distance < 1000 ? `${st.distance.toFixed(0)} m` : `${(st.distance / 1000).toFixed(2)} km`}</span>
              <span className="muted">Top speed</span><span className="mono">{st.maxSpeed.toFixed(1)} m/s</span>
              {acc != null && <><span className="muted">Accuracy</span><span className="mono">{acc}% ({st.hits}/{st.shots})</span></>}
              {st.kills + st.captures > 0 && <><span className="muted">Kills · captures</span><span className="mono">{st.kills} · {st.captures}</span></>}
              {st.deliveries > 0 && <><span className="muted">Deliveries</span><span className="mono">{st.deliveries}</span></>}
              <span className="muted">Damage taken</span><span className="mono">{st.damageTaken.toFixed(0)} HP</span>
            </div>
          </div>
          <div>
            <div className="eyebrow">Your best runs</div>
            {after?.board.length ? (
              <ol className="sim-board">
                {after.board.slice(0, 8).map((r, i) => (
                  <li key={r.at} className={r.at === after.at ? 'you' : ''}>
                    <span className="mono faint">{i + 1}</span><span className="grow">{r.droneName}<span className="tiny faint"> · {new Date(r.at).toLocaleDateString()}</span></span><b className="mono">{r.score.toLocaleString()}</b>
                  </li>
                ))}
              </ol>
            ) : <p className="small faint">{mission.id === 'free' ? 'Free flight is not scored.' : 'Nothing scored this run. Hit a target or clear a gate to get on the board.'}</p>}
            {mission.id !== 'free' && <p className="tiny faint" style={{ marginTop: 8 }}>Scores are saved in this browser only.</p>}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          <button className="btn primary lg" onClick={onRetry} autoFocus>Fly again</button>
          <button className="btn lg" onClick={onExit}>Change mission</button>
        </div>
      </div>
    </div>
  )
}
