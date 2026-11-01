/**
 * Offscreen renders of drones: hangar thumbnails, showcase cards and technical-sheet tiles.
 * One shared WebGL context renders everything, so a page full of cards costs one context.
 */
import * as THREE from 'three'
import type { DroneSpec } from '../engine/types'
import { buildGeometry, mergeByMaterial } from '../engine/geometry'
import { droneMaterials, updateDroneMaterials } from '../components/three/materials'

let renderer: THREE.WebGLRenderer | null = null
const cache = new Map<string, string>()
/** One material set per stealth mode, re-coloured per drone, so thumbnails never recompile shaders. */
const matSets = new Map<boolean, ReturnType<typeof droneMaterials>>()

function getRenderer() {
  if (renderer) return renderer
  const canvas = document.createElement('canvas')
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.debug.checkShaderErrors = import.meta.env.DEV
  return renderer
}

export interface ShotOpts { w?: number; h?: number; yawDeg?: number; elevDeg?: number; ortho?: boolean; bg?: string | null; fill?: number }

/** Render a drone to a PNG data URL. Model frame is Z-up; the camera works in that frame directly. */
export function renderDrone(spec: DroneSpec, o: ShotOpts = {}): string {
  const w = o.w ?? 360, h = o.h ?? 240
  const key = JSON.stringify([spec, o])
  const hit = cache.get(key)
  if (hit) return hit
  let r: THREE.WebGLRenderer
  try { r = getRenderer() } catch { return '' }
  r.setSize(w, h, false)
  const scene = new THREE.Scene()
  if (o.bg) scene.background = new THREE.Color(o.bg)
  const g = buildGeometry(spec)
  const size = Math.max(g.size.x, g.size.y)
  const stealth = spec.systems.some(s => s.id === 'stealth')
  let mats = matSets.get(stealth)
  if (!mats) { mats = droneMaterials(spec.livery, size, { stealth }); matSets.set(stealth, mats) }
  updateDroneMaterials(mats, spec.livery, size, { stealth })
  const merged = mergeByMaterial(g)
  for (const [k, geo] of merged) scene.add(new THREE.Mesh(geo, mats[k]))
  const zAxis = new THREE.Vector3(0, 0, 1)
  for (const rt of g.rotors) {
    const grp = new THREE.Group()
    grp.position.copy(rt.center)
    grp.quaternion.setFromUnitVectors(zAxis, rt.axis)
    grp.add(new THREE.Mesh(rt.blades, mats.prop), new THREE.Mesh(rt.hub, mats.motor))
    scene.add(grp)
  }
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a2f36, 1.4))
  const key1 = new THREE.DirectionalLight(0xffffff, 2.2); key1.position.set(2, -1.5, 3); scene.add(key1)
  const rim = new THREE.DirectionalLight(0x9fc3ff, 1.0); rim.position.set(-3, 2, 1); scene.add(rim)

  const yaw = ((o.yawDeg ?? -38) * Math.PI) / 180, el = ((o.elevDeg ?? 24) * Math.PI) / 180
  const radius = g.size.length() / 2
  const fill = o.fill ?? 1.0
  let cam: THREE.Camera
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(yaw), Math.cos(el) * Math.sin(yaw), Math.sin(el))
  if (o.ortho) {
    const half = (radius * 1.05) / fill
    const a = w / h
    const c = new THREE.OrthographicCamera(-half * a, half * a, half, -half, 0.001, radius * 40)
    c.position.copy(dir.multiplyScalar(radius * 8))
    c.up.set(0, 0, 1)
    if (Math.abs(el) > 1.5) c.up.set(1, 0, 0)
    c.lookAt(0, 0, 0)
    cam = c
  } else {
    const c = new THREE.PerspectiveCamera(30, w / h, radius / 100, radius * 60)
    const d = (radius / Math.sin((15 * Math.PI) / 180)) * 1.02 / fill
    c.position.copy(dir.multiplyScalar(d))
    c.up.set(0, 0, 1)
    c.lookAt(0, 0, 0)
    cam = c
  }
  r.setClearColor(0x000000, 0)
  r.render(scene, cam)
  const url = r.domElement.toDataURL('image/png')
  merged.forEach(m => m.dispose())
  if (cache.size > 300) cache.clear()
  cache.set(key, url)
  return url
}
