import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react'
import { sfx } from '../lib/sound'

/** The brand mark is a Risley-prism rosette: the scan pattern of the Livox sensor this site models. */
export function Rosette({ size = 28, stroke = 'var(--act)', width = 1.6, petals = 6, spin = false }: { size?: number; stroke?: string; width?: number; petals?: number; spin?: boolean }) {
  const pts: string[] = []
  const b = petals - 1
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2
    const x = 0.5 * (Math.cos(t) + Math.cos(-b * t))
    const y = 0.5 * (Math.sin(t) + Math.sin(-b * t))
    pts.push(`${(50 + x * 44).toFixed(2)},${(50 + y * 44).toFixed(2)}`)
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={spin ? { animation: 'spin 9s linear infinite' } : undefined}>
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth={width * (100 / size)} strokeLinejoin="round" />
      <circle cx="50" cy="50" r={5} fill={stroke} />
    </svg>
  )
}

export function Modal({ onClose, children, wide, label }: { onClose: () => void; children: ReactNode; wide?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        {children}
      </div>
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange, size }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' }) {
  return (
    <div className="seg" role="radiogroup" style={size === 'sm' ? { fontSize: 12 } : undefined}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title}
          className={value === o.value ? 'on' : ''} onClick={() => { sfx.click(); onChange(o.value) }}>{o.label}</button>
      ))}
    </div>
  )
}

export function Range({ value, min, max, step, onChange, label, format, style }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label?: string; format?: (v: number) => string; style?: CSSProperties
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`
  return (
    <label className="field" style={style}>
      {label && <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{label}</span><b className="mono" style={{ color: 'var(--ink)', fontWeight: 500 }}>{format ? format(value) : value}</b></span>}
      <input className="range" type="range" min={min} max={max} step={step ?? (max - min) / 200} value={value}
        style={{ ['--fill' as string]: fill } as CSSProperties} onChange={e => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  )
}

export function Meter({ value, color, height = 6 }: { value: number; color?: string; height?: number }) {
  return <div className="bar" style={{ height }}><i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} /></div>
}

export function Spinner() { return <span className="spinner" aria-label="Working" /> }

export function money(v: number) {
  return v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v).toLocaleString()}`
}

export function fmtMass(kg: number) { return kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(kg < 10 ? 2 : 1)} kg` }
export function fmtLen(m: number) { return m < 1 ? `${Math.round(m * 1000)} mm` : `${m.toFixed(2)} m` }
export function fmtMin(min: number) { return min >= 90 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min` }

export function Icon({ name, size = 18 }: { name: 'lock' | 'plus' | 'play' | 'scan' | 'download' | 'trash' | 'copy' | 'edit' | 'sun' | 'moon' | 'sound' | 'mute' | 'menu' | 'close' | 'heart' | 'eye' | 'upload' | 'star' | 'check' | 'arrow'; size?: number }) {
  const p: Record<string, ReactNode> = {
    lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="M7 5l12 7-12 7z" />,
    scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><circle cx="12" cy="12" r="3" /></>,
    download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
    upload: <><path d="M12 20V9M7 14l5-5 5 5" /><path d="M5 4h14" /></>,
    trash: <><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
    sound: <><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></>,
    mute: <><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M17 9l5 6M22 9l-5 6" /></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    heart: <path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z" />,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    star: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
    check: <path d="M5 12l5 5 9-10" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name]}</svg>
}

export function download(data: Uint8Array | string | Blob, filename: string, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : (data as unknown as BlobPart)], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
