import { useEffect, useState } from 'react'
import type { DroneSpec } from '../engine/types'
import { renderDrone } from '../lib/thumbs'
import { systemById, weaponById } from '../engine/parts'

/** Thumbnail rendered lazily when the browser is idle, so a long drone list stays smooth. */
export function Thumb({ spec, w = 360, h = 220, style }: { spec: DroneSpec; w?: number; h?: number; style?: React.CSSProperties }) {
  const [src, setSrc] = useState<string>('')
  useEffect(() => {
    let alive = true
    const go = () => { if (alive) setSrc(renderDrone(spec, { w, h })) }
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
    if (ric) ric(go, { timeout: 600 }); else setTimeout(go, 30)
    return () => { alive = false }
  }, [spec, w, h])
  return src
    ? <img src={src} alt={`${spec.name} render`} width={w} height={h} style={{ width: '100%', height: 'auto', display: 'block', ...style }} />
    : <div style={{ aspectRatio: `${w} / ${h}`, display: 'grid', placeItems: 'center', ...style }}><span className="spinner" /></div>
}

/** The weapons and systems a drone carries, as small tags. */
export function Loadout({ spec }: { spec: DroneSpec }) {
  const items = [...spec.weapons.map(w => weaponById(w.id)), ...spec.systems.map(s => systemById(s.id))].filter(Boolean)
  if (!items.length) return <span className="tiny faint">Unarmed · no systems</span>
  return (
    <span className="row" style={{ gap: 4 }}>
      {items.map((m, i) => <span key={i} className="tag" title={m!.name}>{m!.glyph} {m!.short}</span>)}
    </span>
  )
}
