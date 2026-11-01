/**
 * Tiny procedural UI sound kit. No audio files: every sound is synthesised, so the bundle stays
 * small and nothing has to load. Muted state persists per browser.
 */
import { readString, writeString } from './storage'
import { STORAGE_PREFIX } from '../config'

let ctx: AudioContext | null = null
const MUTE_KEY = `${STORAGE_PREFIX}mute`
let muted = readString(MUTE_KEY) === '1'

export function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try { ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)() } catch { return null }
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export const isMuted = () => muted
export function setMuted(m: boolean) { muted = m; writeString(MUTE_KEY, m ? '1' : '0') }

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.06, when = 0, slide?: number) {
  if (muted) return
  const a = audio(); if (!a) return
  const t = a.currentTime + when
  const o = a.createOscillator(), g = a.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination)
  o.start(t); o.stop(t + dur + 0.02)
}

export const sfx = {
  click: () => tone(880, 0.05, 'triangle', 0.035),
  snap: () => { tone(520, 0.06, 'square', 0.025); tone(1040, 0.08, 'triangle', 0.03, 0.03) },
  up: () => tone(660, 0.12, 'sine', 0.04, 0, 990),
  down: () => tone(520, 0.12, 'sine', 0.035, 0, 330),
  error: () => { tone(220, 0.12, 'sawtooth', 0.03); tone(180, 0.16, 'sawtooth', 0.03, 0.08) },
  chime: () => { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.35, 'sine', 0.045, i * 0.07)) },
  xp: () => tone(1200, 0.07, 'triangle', 0.03, 0, 1600),
  scan: () => tone(320, 0.25, 'sine', 0.025, 0, 1280),
}
