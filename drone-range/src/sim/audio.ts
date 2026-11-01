/**
 * Procedural flight audio: motor note that follows thrust and airframe size, wind that follows
 * airspeed, and synthesised one-shots for weapons and events. Nothing is downloaded.
 */
import { audio, isMuted } from '../lib/sound'
import type { SoundKind } from './game'

let noiseBuf: AudioBuffer | null = null
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf
  const n = ctx.sampleRate * 2
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  return noiseBuf
}

export class SimAudio {
  private ctx: AudioContext | null
  private master: GainNode | null = null
  private motorA: OscillatorNode | null = null
  private motorB: OscillatorNode | null = null
  private motorGain: GainNode | null = null
  private motorFilter: BiquadFilterNode | null = null
  private chop: GainNode | null = null
  private chopLfo: OscillatorNode | null = null
  private wind: AudioBufferSourceNode | null = null
  private windGain: GainNode | null = null
  private windFilter: BiquadFilterNode | null = null
  private laser: OscillatorNode | null = null
  private laserGain: GainNode | null = null
  private base: number
  readonly kind: string

  constructor(kind: 'multirotor' | 'wing' | 'vtol' | 'heli', span: number) {
    this.kind = kind
    // Small props whine, big rotors drone: blade-pass note falls with size.
    this.base = kind === 'heli' ? 55 : Math.max(70, Math.min(420, 150 / Math.sqrt(Math.max(span, 0.1))))
    this.ctx = audio()
    const ctx = this.ctx
    if (!ctx) return
    this.master = ctx.createGain()
    this.master.gain.value = isMuted() ? 0 : 0.9
    this.master.connect(ctx.destination)

    this.motorFilter = ctx.createBiquadFilter()
    this.motorFilter.type = 'lowpass'
    this.motorFilter.frequency.value = this.base * 6
    this.motorGain = ctx.createGain()
    this.motorGain.gain.value = 0
    this.chop = ctx.createGain()
    this.chop.gain.value = 1
    this.motorA = ctx.createOscillator(); this.motorA.type = 'sawtooth'
    this.motorB = ctx.createOscillator(); this.motorB.type = 'square'
    this.motorA.frequency.value = this.base; this.motorB.frequency.value = this.base * 1.013
    const bGain = ctx.createGain(); bGain.gain.value = 0.35
    this.motorA.connect(this.motorFilter)
    this.motorB.connect(bGain).connect(this.motorFilter)
    this.motorFilter.connect(this.motorGain).connect(this.chop).connect(this.master)
    if (kind === 'heli') {
      // blade slap: amplitude modulated at blade-pass rate
      this.chopLfo = ctx.createOscillator()
      this.chopLfo.frequency.value = 18
      const depth = ctx.createGain(); depth.gain.value = 0.6
      this.chopLfo.connect(depth).connect(this.chop.gain)
      this.chopLfo.start()
    }
    this.motorA.start(); this.motorB.start()

    this.wind = ctx.createBufferSource()
    this.wind.buffer = noise(ctx)
    this.wind.loop = true
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master)
    this.wind.start()

    this.laser = ctx.createOscillator(); this.laser.type = 'sine'; this.laser.frequency.value = 1760
    this.laserGain = ctx.createGain(); this.laserGain.gain.value = 0
    this.laser.connect(this.laserGain).connect(this.master)
    this.laser.start()
  }

  update(thrustFrac: number, airspeed: number, laserOn: boolean, active: boolean) {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime
    this.master.gain.setTargetAtTime(isMuted() ? 0 : 0.9, t, 0.05)
    const on = active ? 1 : 0
    const f = this.base * (0.55 + 0.75 * Math.sqrt(Math.max(thrustFrac, 0)))
    this.motorA!.frequency.setTargetAtTime(f, t, 0.06)
    this.motorB!.frequency.setTargetAtTime(f * 1.013, t, 0.06)
    this.motorFilter!.frequency.setTargetAtTime(f * (3 + 4 * thrustFrac), t, 0.08)
    this.motorGain!.gain.setTargetAtTime(on * (0.025 + 0.05 * Math.min(thrustFrac, 1)), t, 0.08)
    if (this.chopLfo) this.chopLfo.frequency.setTargetAtTime(12 + 10 * thrustFrac, t, 0.1)
    this.windGain!.gain.setTargetAtTime(on * Math.min(0.12, (airspeed / 40) ** 2 * 0.12), t, 0.15)
    this.windFilter!.frequency.setTargetAtTime(300 + airspeed * 25, t, 0.2)
    this.laserGain!.gain.setTargetAtTime(laserOn && active ? 0.018 : 0, t, 0.02)
  }

  play(kind: SoundKind, dist = 0, gain = 1) {
    const ctx = this.ctx
    if (!ctx || !this.master || isMuted()) return
    const att = gain / (1 + dist / 40)
    if (att < 0.02) return
    const t = ctx.currentTime
    const tone = (f: number, dur: number, type: OscillatorType, g: number, when = 0, to?: number) => {
      const o = ctx.createOscillator(), a = ctx.createGain()
      o.type = type
      o.frequency.setValueAtTime(f, t + when)
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + when + dur)
      a.gain.setValueAtTime(0, t + when)
      a.gain.linearRampToValueAtTime(g * att, t + when + 0.005)
      a.gain.exponentialRampToValueAtTime(0.0001, t + when + dur)
      o.connect(a).connect(this.master!)
      o.start(t + when); o.stop(t + when + dur + 0.05)
    }
    const burst = (dur: number, ftype: BiquadFilterType, f: number, g: number, when = 0, fTo?: number, q = 0.8) => {
      const s = ctx.createBufferSource(); s.buffer = noise(ctx)
      const fl = ctx.createBiquadFilter(); fl.type = ftype; fl.frequency.setValueAtTime(f, t + when); fl.Q.value = q
      if (fTo) fl.frequency.exponentialRampToValueAtTime(fTo, t + when + dur)
      const a = ctx.createGain()
      a.gain.setValueAtTime(g * att, t + when)
      a.gain.exponentialRampToValueAtTime(0.0001, t + when + dur)
      s.connect(fl).connect(a).connect(this.master!)
      s.start(t + when, Math.random()); s.stop(t + when + dur + 0.05)
    }
    switch (kind) {
      case 'shot': burst(0.07, 'bandpass', 1800, 0.22); tone(140, 0.06, 'sine', 0.12, 0, 60); break
      case 'enemyShot': burst(0.05, 'bandpass', 2600, 0.12); break
      case 'boom': burst(0.9, 'lowpass', 900, 0.5, 0, 120); tone(70, 0.6, 'sine', 0.35, 0, 30); break
      case 'net': tone(220, 0.14, 'triangle', 0.18, 0, 70); burst(0.12, 'highpass', 2000, 0.06); break
      case 'missile': burst(0.9, 'bandpass', 500, 0.18, 0, 2400, 2); break
      case 'emp': tone(2400, 0.7, 'sawtooth', 0.08, 0, 60); burst(0.6, 'lowpass', 3000, 0.15, 0, 200); break
      case 'ring': tone(988, 0.18, 'triangle', 0.1); tone(1480, 0.25, 'triangle', 0.09, 0.07); break
      case 'hit': tone(2600, 0.04, 'square', 0.05); break
      case 'hurt': tone(110, 0.2, 'sawtooth', 0.12, 0, 50); burst(0.15, 'lowpass', 1400, 0.2); break
      case 'pickup': tone(440, 0.1, 'triangle', 0.1); tone(660, 0.12, 'triangle', 0.1, 0.06); break
      case 'drop': tone(500, 0.12, 'triangle', 0.08, 0, 250); break
      case 'deliver': [784, 988, 1319].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, i * 0.07)); break
      case 'capture': [523, 784, 1047, 1568].forEach((f, i) => tone(f, 0.25, 'triangle', 0.08, i * 0.05)); break
      case 'lock': tone(1760, 0.06, 'square', 0.05); tone(1760, 0.06, 'square', 0.05, 0.09); break
      case 'warn': tone(880, 0.12, 'square', 0.05); tone(660, 0.12, 'square', 0.05, 0.14); break
      case 'chute': burst(0.8, 'bandpass', 700, 0.2, 0, 200); break
      case 'launch': burst(0.35, 'bandpass', 900, 0.15, 0, 2000, 3); tone(300, 0.3, 'sawtooth', 0.04, 0, 900); break
      case 'smoke': burst(1.2, 'highpass', 2500, 0.12, 0, 900); break
      case 'wave': tone(440, 0.3, 'sawtooth', 0.06, 0, 880); tone(440, 0.3, 'sawtooth', 0.06, 0.35, 880); break
      case 'zone': [659, 880, 1175].forEach((f, i) => tone(f, 0.3, 'sine', 0.09, i * 0.09)); break
      case 'empty': tone(300, 0.04, 'square', 0.04); break
      case 'laser': break
    }
  }

  dispose() {
    try {
      this.motorA?.stop(); this.motorB?.stop(); this.wind?.stop(); this.laser?.stop(); this.chopLfo?.stop()
      this.master?.disconnect()
    } catch { /* already stopped */ }
  }
}
