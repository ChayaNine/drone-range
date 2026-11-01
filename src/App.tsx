import { Suspense, lazy, useEffect } from 'react'
import { HashRouter, MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Rosette } from './components/ui'

const Home = lazy(() => import('./pages/Home'))
const Flight = lazy(() => import('./pages/Flight'))

/**
 * react-router builds every link with `new URL(path, base)`. In a sandboxed iframe, a srcdoc page
 * or a blob: preview the base is not a valid URL and that call throws, so the app would never
 * render. In that rare case route in memory instead. Everywhere else the hash router is used: it
 * needs no server rewrite rules, so the built site works on GitHub Pages, from a folder, or from disk.
 */
function urlRoutingWorks(): boolean {
  try {
    const l = window.location
    new URL('/', l.origin && l.origin !== 'null' ? l.origin : l.href)
    return true
  } catch { return false }
}

const Router = urlRoutingWorks() ? HashRouter : MemoryRouter

function Loading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
      <div className="col" style={{ alignItems: 'center' }}>
        <Rosette size={54} spin />
        <span className="eyebrow">Spooling up</span>
      </div>
    </div>
  )
}

function ScrollTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

export function App() {
  return (
    <Router>
      <ScrollTop />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Shell><Home /></Shell>} />
          <Route path="/fly/:droneId/:env/:mission" element={<Flight />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Router>
  )
}
