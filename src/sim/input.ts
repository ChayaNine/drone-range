/**
 * Keyboard, mouse (pointer lock), gamepad and touch merged into one control frame.
 * Continuous axes are read every frame; one-shot actions are delivered through onAction.
 */
import type { Input } from './flight'

export type Action = 'sys1' | 'sys2' | 'hook' | 'transition' | 'camera' | 'pause' | 'restart' | 'assist' | 'help' | 'map'

export interface ControlFrame {
  axes: Input
  fire: [boolean, boolean]
  /** Gimbal pitch change this frame, radians (positive = look up). */
  aimDelta: number
}

const ACTION_KEYS: Record<string, Action> = {
  Digit1: 'sys1', Digit2: 'sys2', KeyB: 'hook', KeyT: 'transition', KeyC: 'camera', KeyV: 'camera',
  KeyP: 'pause', Escape: 'pause', Backspace: 'restart', KeyM: 'assist', KeyH: 'help', KeyN: 'map',
}
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyR', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ...Object.keys(ACTION_KEYS)])

export interface TouchState { lx: number; ly: number; rx: number; ry: number; fire1: boolean; fire2: boolean; active: boolean }

export class InputManager {
  keys = new Set<string>()
  mouse: [boolean, boolean] = [false, false]
  touch: TouchState = { lx: 0, ly: 0, rx: 0, ry: 0, fire1: false, fire2: false, active: false }
  onAction: ((a: Action) => void) | null = null
  locked = false
  /** Mouse sensitivity, radians per pixel. */
  sens = 0.0022
  private mdx = 0
  private mdy = 0
  private yawSmooth = 0
  private padPrev: boolean[] = []
  private el: HTMLElement | null = null

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (GAME_KEYS.has(e.code)) e.preventDefault()
    if (e.repeat) return
    this.keys.add(e.code)
    const a = ACTION_KEYS[e.code]
    if (a) this.onAction?.(a)
  }
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code) }
  private onBlur = () => { this.keys.clear(); this.mouse = [false, false] }
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouse[0] = true
    if (e.button === 2) this.mouse[1] = true
    if (!this.locked && this.el && e.button === 0 && e.target === this.el) {
      // Optional: some browsers and embedded views refuse pointer lock. Keyboard aiming still works.
      try { const r = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined; r?.catch?.(() => {}) } catch { /* refused */ }
    }
  }
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouse[0] = false
    if (e.button === 2) this.mouse[1] = false
  }
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.mdx += e.movementX
    this.mdy += e.movementY
  }
  private onLockChange = () => { this.locked = document.pointerLockElement === this.el }
  private onContext = (e: Event) => e.preventDefault()

  attach(el: HTMLElement) {
    this.el = el
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
    el.addEventListener('contextmenu', this.onContext)
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.el?.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.el?.removeEventListener('contextmenu', this.onContext)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    if (document.pointerLockElement === this.el) document.exitPointerLock?.()
    this.el = null
  }

  releasePointer() { if (document.pointerLockElement) document.exitPointerLock?.() }

  read(dt: number): ControlFrame {
    const k = this.keys
    const ax = (pos: string[], neg: string[]) => (pos.some(c => k.has(c)) ? 1 : 0) - (neg.some(c => k.has(c)) ? 1 : 0)
    let pitch = ax(['KeyW'], ['KeyS'])
    let roll = ax(['KeyD'], ['KeyA'])
    let yaw = ax(['KeyE', 'ArrowRight'], ['KeyQ', 'ArrowLeft'])
    let throttle = ax(['Space'], ['ShiftLeft', 'ShiftRight'])
    let aimDelta = ax(['ArrowUp'], ['ArrowDown']) * 0.9 * dt
    let fire1 = k.has('KeyF') || this.mouse[0]
    let fire2 = k.has('KeyR') || this.mouse[1]

    // mouse: vertical moves the gimbal, horizontal steers
    if (this.locked) {
      aimDelta += -this.mdy * this.sens
      const want = Math.max(-1, Math.min(1, (this.mdx * this.sens) / Math.max(dt, 1e-3) / 2.2))
      this.yawSmooth += (want - this.yawSmooth) * Math.min(1, dt * 18)
      yaw += this.yawSmooth
    } else this.yawSmooth = 0
    this.mdx = 0; this.mdy = 0

    // gamepad (standard mapping, Mode 2)
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
    const pad = pads && [...pads].find(p => p && p.connected)
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88)
      yaw += dz(pad.axes[0] ?? 0)
      throttle += -dz(pad.axes[1] ?? 0)
      roll += dz(pad.axes[2] ?? 0)
      pitch += -dz(pad.axes[3] ?? 0)
      const b = pad.buttons.map(x => x.pressed || x.value > 0.4)
      fire1 = fire1 || !!b[7]
      fire2 = fire2 || !!b[6]
      if (b[12] || b[5]) aimDelta += 0.9 * dt
      if (b[13] || b[4]) aimDelta -= 0.9 * dt
      const edge = (i: number, a: Action) => { if (b[i] && !this.padPrev[i]) this.onAction?.(a) }
      edge(0, 'sys1'); edge(1, 'sys2'); edge(2, 'hook'); edge(3, 'camera'); edge(9, 'pause'); edge(8, 'restart'); edge(10, 'transition'); edge(11, 'assist')
      this.padPrev = b
    }

    if (this.touch.active) {
      yaw += this.touch.lx
      throttle += -this.touch.ly
      roll += this.touch.rx
      pitch += -this.touch.ry
      fire1 = fire1 || this.touch.fire1
      fire2 = fire2 || this.touch.fire2
    }

    const c = (v: number) => Math.max(-1, Math.min(1, v))
    return { axes: { pitch: c(pitch), roll: c(roll), yaw: c(yaw), throttle: c(throttle) }, fire: [fire1, fire2], aimDelta }
  }
}
