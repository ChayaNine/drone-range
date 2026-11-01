/**
 * three.js sends every log, warning and error through one hook (setConsoleFunction). Two of its
 * warnings are noise for this site, so they are dropped here; everything else, including real
 * shader errors, still reaches the console unchanged.
 *
 * 1. "Clock: This module has been deprecated. Please use THREE.Timer instead."
 *    Raised by @react-three/fiber (9.8.1, the latest release), which creates a THREE.Clock for each
 *    canvas. Nothing in this codebase uses Clock. Remove this rule once fiber switches to Timer.
 *
 * 2. "WebGLProgram: Program Info Log: … warning X4122: sum of 1 and -1.49e-17 cannot be represented
 *    accurately in double precision"
 *    On Windows, browsers translate WebGL shaders to Direct3D, and the Direct3D compiler adds notes
 *    like this about float rounding in three's built-in depth/shadow packing. The shader compiled
 *    and runs; it is a compiler note, not an error. Only logs made entirely of such Direct3D
 *    warnings are dropped; anything containing an error is kept.
 */
import { setConsoleFunction } from 'three'

const D3D_WARNING = /^\(\d+,\d+(-\d+)?\): warning X\d{4}:/

function onlyCompilerNotes(log: unknown): boolean {
  if (typeof log !== 'string') return false
  const lines = log.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(l => D3D_WARNING.test(l))
}

export function isThreeNoise(message: string, params: unknown[]): boolean {
  if (message.startsWith('THREE.Clock: This module has been deprecated')) return true
  if (message.startsWith('THREE.WebGLProgram: Program Info Log') && onlyCompilerNotes(params[0])) return true
  return false
}

let installed = false
export function installThreeConsole() {
  if (installed) return
  installed = true
  setConsoleFunction((type: 'log' | 'warn' | 'error', message: string, ...params: unknown[]) => {
    if (type !== 'error' && isThreeNoise(message, params)) return
    // eslint-disable-next-line no-console
    console[type](message, ...params)
  })
}
