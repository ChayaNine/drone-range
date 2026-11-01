/** Small helpers that keep the 3D views smooth without changing how they look. */
import { useEffect, useState, type RefObject } from 'react'
import type { WebGLRenderer } from 'three'

/**
 * Production renderers skip three's per-shader error check: it forces the browser to finish each
 * shader compile synchronously (a visible hitch, worst on Windows/Direct3D) only to read a log.
 * Development builds keep it so real shader errors still show up.
 */
export function tuneRenderer(gl: WebGLRenderer) {
  gl.debug.checkShaderErrors = import.meta.env.DEV
}

/** True while the element is on screen; 3D views stop drawing when scrolled away. */
export function useOnScreen(ref: RefObject<Element | null>, margin = '120px'): boolean {
  const [on, setOn] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, margin])
  return on
}
