import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Rosette, Icon } from './ui'
import { BRAND, STORAGE_PREFIX } from '../config'
import { isMuted, setMuted } from '../lib/sound'
import { readString, writeString } from '../lib/storage'

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => (readString(`${STORAGE_PREFIX}theme`) as 'light' | 'dark') || 'system')
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    writeString(`${STORAGE_PREFIX}theme`, theme === 'system' ? '' : theme)
  }, [theme])
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  return { dark, toggle: () => setTheme(dark ? 'light' : 'dark') }
}

export function Shell({ children }: { children: ReactNode }) {
  const { dark, toggle } = useTheme()
  const [muted, setM] = useState(isMuted())
  const [first, ...rest] = BRAND.name.split(' ')
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label={`${BRAND.name} home`}>
          <Rosette size={30} />
          <span className="brand-word">{first}{rest.length ? <small>{rest.join(' ')}</small> : <small>{BRAND.tagline}</small>}</span>
        </Link>
        <div className="topbar-right">
          {BRAND.repoUrl && <a className="btn sm quiet hide-xs" href={BRAND.repoUrl} target="_blank" rel="noreferrer">Source on GitHub</a>}
          <button className="btn quiet icon sm" aria-label={muted ? 'Unmute sounds' : 'Mute sounds'} onClick={() => { setMuted(!muted); setM(!muted) }}><Icon name={muted ? 'mute' : 'sound'} size={16} /></button>
          <button className="btn quiet icon sm" aria-label={dark ? 'Light theme' : 'Dark theme'} onClick={toggle}><Icon name={dark ? 'sun' : 'moon'} size={16} /></button>
        </div>
      </header>
      <main className="page">{children}</main>
      <footer className="site-foot">
        <span>Weapons and sensors are fictional game modules with abstract stats. Performance figures are model estimates, not manufacturer data. </span>
        {BRAND.repoUrl && <a href={BRAND.repoUrl} target="_blank" rel="noreferrer">MIT licensed</a>}
      </footer>
    </div>
  )
}
