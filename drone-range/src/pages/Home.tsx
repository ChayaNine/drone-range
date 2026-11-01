/**
 * The start screen: choose a drone, an environment and a mission, then launch.
 * Drones come from src/drones/*.drone.json plus anything you add in the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useLibrary, type LibraryDrone } from '../lib/library'
import { SpecError, droneFile, loadDrone, slug } from '../lib/spec'
import { DroneViewer } from '../components/three/Viewer'
import { Loadout, Thumb } from '../components/DroneBits'
import { Icon, Modal, Range, download, fmtMass, fmtMin } from '../components/ui'
import { computePerformance } from '../engine/performance'
import type { DroneSpec } from '../engine/types'
import { ENVIRONMENTS, MISSIONS, dailyChallenge, missionKey, type EnvId, type MissionDef, type MissionId } from '../sim/catalog'
import { bestRun, topRuns } from '../lib/scores'
import { sfx } from '../lib/sound'

/** How well a drone suits a mission, in one line. */
function fit(m: MissionDef, s: DroneSpec, kind: string): { ok: boolean; note: string } {
  const need = m.needs?.(s)
  if (need) return { ok: false, note: need }
  const sys = s.systems.map(x => x.id), wpn = s.weapons.map(x => x.id)
  if (m.id === 'delivery') return { ok: true, note: kind === 'wing' ? 'Air-drop mode: release pods over the pads' : sys.includes('winch') ? 'Winch fitted: hook from 15 m' : 'Hook from 2.5 m — a winch helps' }
  if (m.id === 'recon') return { ok: true, note: sys.includes('lidar') ? 'LiDAR scans 2× faster' : sys.includes('thermal') ? 'Thermal scans 1.5× faster' : 'Fit LiDAR or thermal to scan faster' }
  if (m.id === 'intercept') return { ok: true, note: wpn.includes('net') || wpn.includes('emp') ? 'Captures score double' : 'Nets or a pulse would score double' }
  if (m.id === 'rings') return { ok: true, note: kind === 'wing' ? 'Wide course for aeroplanes' : 'Course spacing scales with your top speed' }
  if (m.id === 'targets') return { ok: true, note: wpn.includes('laser') ? 'Painted targets score ×2' : 'Accuracy bonus at the end' }
  if (m.id === 'survival') return { ok: true, note: sys.includes('smoke') ? 'Smoke breaks their tracking' : 'Waves get faster and meaner' }
  return { ok: true, note: 'No clock. Just fly.' }
}

type Notice = { kind: 'ok' | 'bad'; text: string; problems?: string[] }

const DEFAULT_DRONE = 'bundled-warden-hexa'

export default function Home() {
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const bundled = useLibrary(s => s.bundled)
  const mine = useLibrary(s => s.mine)
  const addFromText = useLibrary(s => s.addFromText)
  const remove = useLibrary(s => s.remove)
  const daily = useMemo(() => dailyChallenge(), [])

  const drones = useMemo<LibraryDrone[]>(() => [...mine, ...bundled], [mine, bundled])
  const perfs = useMemo(() => new Map(drones.map(d => [d.id, computePerformance(d.spec)])), [drones])

  const [droneId, setDroneId] = useState<string>(() => {
    const want = sp.get('drone')
    return drones.find(d => d.id === want)?.id ?? drones.find(d => d.id === DEFAULT_DRONE)?.id ?? drones[0]?.id ?? ''
  })
  const [isDaily, setDaily] = useState(!!sp.get('daily'))
  const [env, setEnv] = useState<EnvId>(isDaily ? daily.env.id : 'range')
  const [mission, setMission] = useState<MissionId>(isDaily ? daily.mission.id : 'free')
  const [wind, setWind] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dragging, setDragging] = useState(false)

  const pick = drones.find(d => d.id === droneId) ?? drones[0]
  const perf = pick ? perfs.get(pick.id) : undefined
  const mDef = MISSIONS.find(m => m.id === mission)!
  const eDef = ENVIRONMENTS.find(e => e.id === env)!
  const key = isDaily ? daily.key : missionKey(mission, env)
  const board = useMemo(() => (mission === 'free' && !isDaily ? [] : topRuns(key)), [key, mission, isDaily])

  /** Adds drone files from text. Reports each result; selects the last one that loaded. */
  const ingest = useCallback(async (items: { name: string; text: string }[]) => {
    const failures: string[] = []
    let last: LibraryDrone | null = null
    let added = 0
    for (const it of items) {
      try { last = addFromText(it.text); added++ } catch (e) {
        const probs = e instanceof SpecError ? e.problems : [(e as Error).message]
        failures.push(...probs.map(p => (items.length > 1 ? `${it.name}: ${p}` : p)))
      }
    }
    if (last) setDroneId(last.id)
    if (failures.length) setNotice({ kind: 'bad', text: added ? `Added ${added}, but some files were rejected:` : 'That file was not added:', problems: failures })
    else setNotice({ kind: 'ok', text: added === 1 ? `Added ${last!.spec.name}.${last!.warnings.length ? ` ${last!.warnings[0]}` : ''}` : `Added ${added} drones.` })
    sfx[failures.length ? 'error' : 'up']()
    return !failures.length
  }, [addFromText])

  const ingestFiles = useCallback(async (files: FileList | File[]) => {
    const list = [...files].filter(f => /\.json$/i.test(f.name) || f.type === 'application/json')
    if (!list.length) { setNotice({ kind: 'bad', text: 'Drop a .drone.json file. Other file types are not drone files.' }); return false }
    return ingest(await Promise.all(list.map(async f => ({ name: f.name, text: await f.text() }))))
  }, [ingest])

  // Drag a .drone.json anywhere on the page.
  const ingestRef = useRef(ingestFiles)
  ingestRef.current = ingestFiles
  useEffect(() => {
    let depth = 0
    const files = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
    const enter = (e: DragEvent) => { if (files(e)) { depth++; setDragging(true) } }
    const leave = (e: DragEvent) => { if (files(e) && --depth <= 0) { depth = 0; setDragging(false) } }
    const over = (e: DragEvent) => { if (files(e)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      if (e.dataTransfer?.files.length) void ingestRef.current(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop) }
  }, [])

  if (!pick || !perf) return <div className="empty"><h3>No drones yet</h3><p>Add a <span className="mono">.drone.json</span> file to <span className="mono">src/drones/</span>, or use “Add a drone”.</p></div>
  const f = fit(mDef, pick.spec, perf.kind)
  const best = bestRun(key)
  const useDailyPreset = () => { setDaily(true); setEnv(daily.env.id); setMission(daily.mission.id); setWind(null); sfx.click() }

  const launch = () => {
    if (!f.ok || !perf.flightReady) return
    sfx.up()
    const q = new URLSearchParams()
    if (isDaily) q.set('daily', '1')
    else if (wind != null) q.set('wind', String(wind))
    nav(`/fly/${pick.id}/${env}/${mission}${q.toString() ? `?${q}` : ''}`)
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Simulator</div>
          <h1>Pick a drone, a place, a job</h1>
          <p>It flies with the numbers in the drone's file: thrust, mass, drag, battery and loadout. Heavier weapons cost you speed and flight time.</p>
        </div>
        <div className="row right">
          <button className="btn" onClick={() => { setAdding(true); setNotice(null); sfx.click() }}><Icon name="upload" size={16} /> Add a drone</button>
        </div>
      </div>

      <button className={`card daily-banner ${isDaily ? 'on' : ''}`} onClick={useDailyPreset}>
        <span className="daily-sun">☼</span>
        <div className="grow" style={{ textAlign: 'left' }}>
          <div className="eyebrow">Daily challenge · {daily.date}</div>
          <b>{daily.mission.name} in {daily.env.name}</b> <span className="muted">· {daily.twist.label}</span>
        </div>
        {bestRun(daily.key) ? <span className="chip ok"><Icon name="check" size={12} /> Best today {bestRun(daily.key)!.score.toLocaleString()}</span> : <span className="chip act">Same for everyone, every day</span>}
      </button>

      <div className="fly-grid">
        {/* drones */}
        <section className="card fly-col">
          <div className="card-head"><b>Drone</b><span className="tiny faint right">{drones.length} available</span></div>
          {notice && (
            <div className={`note ${notice.kind}`} style={{ margin: '10px 10px 0' }} role="status">
              {notice.text}
              {notice.problems && <ul className="problems">{notice.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            </div>
          )}
          <div className="fly-list" role="listbox" aria-label="Drone">
            {drones.map(d => {
              const sum = perfs.get(d.id)!
              return (
                <div key={d.id} className="fly-row">
                  <button role="option" aria-selected={d.id === pick.id} className={`fly-drone rarity-${sum.rarity} ${d.id === pick.id ? 'on' : ''}`} onClick={() => { setDroneId(d.id); sfx.click() }}>
                    <Thumb spec={d.spec} w={150} h={90} style={{ borderRadius: 6, width: 96, height: 58, objectFit: 'cover' }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span className="rar-dot" /> {d.spec.name}</div>
                      <div className="tiny faint">{d.source === 'mine' ? 'Added by you · ' : ''}{sum.className}</div>
                      <div className="tiny mono muted">{sum.speed.max.toFixed(0)} m/s · {fmtMin(sum.endurance.bestMin)}{!sum.flightReady ? ' · not ready' : ''}</div>
                    </div>
                  </button>
                  {d.source === 'mine' && (
                    <button className="btn quiet icon sm del" aria-label={`Remove ${d.spec.name}`} title="Remove from this browser"
                      onClick={() => { remove(d.id); if (droneId === d.id) setDroneId(DEFAULT_DRONE); setNotice({ kind: 'ok', text: `Removed ${d.spec.name}.` }); sfx.down() }}><Icon name="trash" size={14} /></button>
                  )}
                </div>
              )
            })}
            <div className="drop-hint">Drop a <span className="mono">.drone.json</span> anywhere on this page to add it</div>
          </div>
        </section>

        {/* where & what */}
        <section className="col" style={{ gap: 16, minWidth: 0 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Environment</div>
            <div className="env-grid">
              {ENVIRONMENTS.map(e => (
                <button key={e.id} className={`env-card ${env === e.id ? 'on' : ''}`} onClick={() => { setEnv(e.id); setDaily(false); sfx.click() }}
                  style={{ background: `linear-gradient(180deg, ${e.sky[0]} 0%, ${e.sky[1]} 62%, ${e.ground} 62%, ${e.ground} 100%)` }}>
                  <span className="env-name">{e.name}</span>
                  <span className="env-wind mono">{e.wind} m/s</span>
                </button>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>{eDef.blurb}</p>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Mission</div>
            <div className="mission-grid">
              {MISSIONS.map(m => {
                const ff = fit(m, pick.spec, perf.kind)
                const b = bestRun(missionKey(m.id, env))
                return (
                  <button key={m.id} className={`mission-card ${mission === m.id ? 'on' : ''} ${ff.ok ? '' : 'locked'}`} onClick={() => { setMission(m.id); setDaily(false); sfx.click() }}>
                    <span className="mission-glyph">{m.glyph}</span>
                    <span className="grow" style={{ textAlign: 'left', minWidth: 0 }}>
                      <b>{m.name}</b>{m.timeLimit ? <span className="tiny faint mono"> · {Math.floor(m.timeLimit / 60)}:{String(m.timeLimit % 60).padStart(2, '0')}</span> : null}
                      <span className="tiny muted" style={{ display: 'block' }}>{m.blurb}</span>
                      <span className={`tiny ${ff.ok ? 'faint' : ''}`} style={{ display: 'block', color: ff.ok ? undefined : 'var(--bad)' }}>{ff.ok ? '' : '⚠ '}{ff.note}</span>
                    </span>
                    {b && <span className="mission-best" title="Your best">{'★'.repeat(b.stars)}{'☆'.repeat(3 - b.stars)}</span>}
                  </button>
                )
              })}
            </div>
          </div>
          {!isDaily && (
            <div className="panel" style={{ padding: 12 }}>
              <Range label="Wind" min={0} max={15} step={0.5} value={wind ?? eDef.wind} onChange={v => setWind(v)} format={v => `${v.toFixed(1)} m/s${wind == null ? ' (default)' : ''}`} />
            </div>
          )}
        </section>

        {/* summary & launch */}
        <section className="card fly-col">
          <DroneViewer spec={pick.spec} height={220} spin={30} autoRotate controls={false} reveal />
          <div className="card-pad col" style={{ gap: 10 }}>
            <div className="row"><b style={{ fontSize: 18 }}>{pick.spec.name}</b><span className="tag right">{perf.className}</span></div>
            <Loadout spec={pick.spec} />
            <div className="kv small">
              <span className="muted">Top speed</span><span className="mono">{perf.speed.max.toFixed(1)} m/s</span>
              <span className="muted">Endurance</span><span className="mono">{fmtMin(perf.endurance.bestMin)}</span>
              <span className="muted">Thrust : weight</span><span className="mono">{perf.thrust.twr.toFixed(2)}</span>
              <span className="muted">Mass</span><span className="mono">{fmtMass(perf.massKg)}</span>
              <span className="muted">Hull</span><span className="mono">{perf.durabilityHp} HP</span>
              <span className="muted">Accuracy</span><span className="mono">{perf.accuracy.score.toFixed(0)}/100</span>
            </div>
            {pick.spec.notes && <p className="tiny faint">{pick.spec.notes}</p>}
            {!perf.flightReady && <div className="note warn">Not flight-ready: {perf.advice[0] ?? 'the model reports a failing check.'}</div>}

            <div className="divider" style={{ margin: '4px 0' }} />
            <div className="row"><b>{mDef.glyph} {mDef.name}</b><span className="small muted right">{eDef.name}</span></div>
            {(mission !== 'free' || isDaily) && (
              <>
                <div className="small muted">Stars at {mDef.stars.map(s => s.toLocaleString()).join(' · ')}{best ? <> · your best <b className="mono">{best.score.toLocaleString()}</b></> : null}</div>
                <ol className="mini-board">
                  {board.length ? board.slice(0, 5).map((r, i) => (
                    <li key={r.at}><span className="mono faint">{i + 1}</span><span className="grow">{r.droneName}</span><b className="mono">{r.score.toLocaleString()}</b></li>
                  )) : <li className="faint">No runs yet — set the first.</li>}
                </ol>
              </>
            )}
            <button className="btn primary lg" disabled={!f.ok || !perf.flightReady} onClick={launch}>
              <Icon name="play" /> {f.ok ? (perf.flightReady ? 'Launch' : 'Not flight-ready') : f.note}
            </button>
            <button className="btn quiet sm" onClick={() => download(droneFile(pick.spec), `${slug(pick.spec.name)}.drone.json`, 'application/json')}><Icon name="download" size={14} /> Download this drone's file</button>
          </div>
        </section>
      </div>

      {adding && <AddDrone onClose={() => setAdding(false)} onAdd={async (items) => { const ok = await ingest(items); if (ok) setAdding(false); return ok }} />}
      {dragging && <div className="drop-veil" aria-hidden="true"><b>Drop to add a drone</b></div>}
    </div>
  )
}

/** Dialog: pick files or paste JSON. Shows exactly what is wrong when a file is rejected. */
function AddDrone({ onClose, onAdd }: { onClose: () => void; onAdd: (items: { name: string; text: string }[]) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const file = useRef<HTMLInputElement>(null)
  const submit = async (items: { name: string; text: string }[]) => {
    // Validate here too so errors show inside the dialog instead of behind it.
    const bad: string[] = []
    for (const it of items) {
      try { loadDrone(it.text) } catch (e) { bad.push(...(e instanceof SpecError ? e.problems : [(e as Error).message])) }
    }
    setProblems(bad)
    if (!bad.length) await onAdd(items)
  }
  return (
    <Modal onClose={onClose} label="Add a drone" wide>
      <div className="modal-head"><h2>Add a drone</h2><button className="btn quiet icon right" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
      <div className="modal-body col" style={{ gap: 12 }}>
        <p className="small muted">Use a <b>.drone.json</b> exported from Drone Surrogate Factory, or a short recipe (name, layout, size, loadout). See <span className="mono">docs/DRONE_FORMAT.md</span> in the repository.</p>
        <div className="row">
          <input ref={file} type="file" accept=".json,application/json" multiple hidden
            onChange={async e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) await submit(await Promise.all(fs.map(async f => ({ name: f.name, text: await f.text() })))) }} />
          <button className="btn" onClick={() => file.current?.click()}><Icon name="upload" size={16} /> Choose file(s)</button>
          <span className="small faint">or paste JSON below</span>
        </div>
        <textarea className="codebox" spellCheck={false} aria-label="Drone JSON" value={text} onChange={e => { setText(e.target.value); setProblems([]) }}
          placeholder={'{\n  "format": "drone-range/recipe/1",\n  "name": "My Quad",\n  "layout": "quad_x",\n  "length": 0.5,\n  "weapons": [{ "id": "kinetic" }]\n}'} />
        {problems.length > 0 && <div className="note bad">That didn't load:<ul className="problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => void submit([{ name: 'pasted JSON', text }])}>Add drone</button>
        </div>
      </div>
    </Modal>
  )
}
