/**
 * Everything the simulator draws. Static world parts are built once per world; anything that
 * moves is written straight into Three objects from useFrame, so React only re-renders when the
 * set of entities changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { World } from './world'
import { groundAt } from './world'
import type { Entity, Game } from './game'
import { DroneModel } from '../components/three/DroneModel'
import type { DroneSpec } from '../engine/types'
import { buildGeometry, type DroneGeometry } from '../engine/geometry'
import { newDesign } from '../engine/presets'

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _c = new THREE.Color()
const X = new THREE.Vector3(1, 0, 0), Zv = new THREE.Vector3(0, 0, 1)
export const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize()

// ───────────────────────────── sky & light ─────────────────────────────

export function Sky({ top, horizon, night }: { top: string; horizon: string; night: boolean }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: new THREE.Color(top) }, uHor: { value: new THREE.Color(horizon) }, uSun: { value: SUN_DIR }, uNight: { value: night ? 1 : 0 } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uSun; uniform float uNight; varying vec3 vD;
      void main(){ float h = clamp(vD.y, -0.2, 1.0); vec3 c = mix(uHor, uTop, pow(max(h, 0.0), 0.55));
      float s = max(dot(normalize(vD), uSun), 0.0); c += (1.0 - uNight) * (vec3(1.0, 0.85, 0.6) * pow(s, 400.0) * 2.0 + vec3(1.0, 0.8, 0.55) * pow(s, 8.0) * 0.18);
      if (vD.y < 0.0) c = mix(uHor, uHor * 0.85, min(-vD.y * 5.0, 1.0));
      gl_FragColor = vec4(c, 1.0); }`,
  }), [top, horizon, night])
  const stars = useMemo(() => {
    if (!night) return null
    const n = 1400, p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, y = Math.abs(u) * 0.95 + 0.05
      const r = Math.sqrt(1 - y * y)
      p.set([Math.cos(a) * r * 2400, y * 2400, Math.sin(a) * r * 2400], i * 3)
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  }, [night])
  const ref = useRef<THREE.Group>(null)
  useFrame(({ camera }) => { ref.current?.position.copy(camera.position) })
  return (
    <group ref={ref}>
      <mesh material={mat} renderOrder={-10} frustumCulled={false}><sphereGeometry args={[2500, 32, 16]} /></mesh>
      {stars && <points geometry={stars} frustumCulled={false}><pointsMaterial size={1.6} sizeAttenuation={false} color="#dfe8ff" fog={false} transparent opacity={0.85} /></points>}
    </group>
  )
}

export function Lights({ game, night, thermal, shadows }: { game: Game; night: boolean; thermal: boolean; shadows: boolean }) {
  const sun = useRef<THREE.DirectionalLight>(null)
  const target = useMemo(() => new THREE.Object3D(), [])
  useFrame(() => {
    const s = sun.current
    if (!s) return
    const p = game.craft.pos
    // snap to a 4 m grid so shadow texels don't swim
    target.position.set(Math.round(p.x / 4) * 4, Math.round(p.y / 4) * 4, Math.round(p.z / 4) * 4)
    s.position.copy(target.position).addScaledVector(SUN_DIR, 300)
    target.updateMatrixWorld()
  })
  const k = thermal ? 1.6 : 1
  return (
    <>
      <primitive object={target} />
      <hemisphereLight args={[night ? '#3a4a70' : '#cfe3ff', night ? '#0b0d12' : '#6b5a44', (night ? 0.35 : 1.15) * k]} />
      <ambientLight intensity={(night ? 0.18 : 0.25) * k} />
      <directionalLight ref={sun} target={target} intensity={night ? 0.25 : 2.6} color={night ? '#9db4ff' : '#fff1dc'}
        castShadow={shadows} shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.04}
        shadow-camera-left={-90} shadow-camera-right={90} shadow-camera-top={90} shadow-camera-bottom={-90} shadow-camera-near={10} shadow-camera-far={700} />
    </>
  )
}

// ───────────────────────────── terrain ─────────────────────────────

function streetTexture(night: boolean) {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  const px = 512 / 80
  g.fillStyle = night ? '#16191e' : '#4a4f55'
  g.fillRect(0, 0, 512, 512)
  // block / sidewalk in the middle of the tile (56 m), street around it
  g.fillStyle = night ? '#23272e' : '#8b8f93'
  g.fillRect(12 * px, 12 * px, 56 * px, 56 * px)
  g.fillStyle = night ? '#1b1f25' : '#9fa3a6'
  g.fillRect(14 * px, 14 * px, 52 * px, 52 * px)
  // centre lines on the tile edges (street centres), dashed
  g.strokeStyle = night ? '#8a7a3a' : '#e8d27a'
  g.lineWidth = 0.35 * px
  g.setLineDash([3 * px, 3 * px])
  for (const v of [0.2, 511.8]) { g.beginPath(); g.moveTo(v, 0); g.lineTo(v, 512); g.stroke(); g.beginPath(); g.moveTo(0, v); g.lineTo(512, v); g.stroke() }
  // crosswalks near the corners
  g.setLineDash([])
  g.fillStyle = night ? '#5a5d63' : '#e9eaeb'
  for (let i = 0; i < 6; i++) {
    for (const [x, y, w, h] of [[i * 1.6 * px + 2 * px, 3 * px, 0.8 * px, 6 * px], [3 * px, i * 1.6 * px + 2 * px, 6 * px, 0.8 * px]]) g.fillRect(x, y, w, h)
  }
  // grime
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`; g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 6, 2 + Math.random() * 6) }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(20, 20)
  t.offset.set(0.5, 0.5)
  t.anisotropy = 8
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function Terrain({ world, night }: { world: World; night: boolean }) {
  const id = world.env.id
  const geo = useMemo(() => {
    if (id !== 'range' && id !== 'forest') return null
    const size = world.half * 2
    const seg = 220
    const g = new THREE.PlaneGeometry(size, size, seg, seg)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position as THREE.BufferAttribute
    const col = new Float32Array(pos.count * 3)
    const a = new THREE.Color(id === 'range' ? '#c9a978' : '#5e7a49'), b = new THREE.Color(id === 'range' ? '#a5865a' : '#3d5a30'), rock = new THREE.Color(id === 'range' ? '#8c7a63' : '#7a7468'), hi = new THREE.Color(id === 'range' ? '#ddc69d' : '#7e9a5b')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i)
      const h = world.height(x, z)
      pos.setY(i, h)
      const e = 2
      const slope = Math.hypot(world.height(x + e, z) - world.height(x - e, z), world.height(x, z + e) - world.height(x, z - e)) / (2 * e)
      const n = Math.sin(x * 0.05) * Math.cos(z * 0.043) * 0.5 + Math.sin(x * 0.17 + z * 0.11) * 0.25
      _c.copy(a).lerp(b, THREE.MathUtils.clamp(0.5 + n, 0, 1) * 0.6).lerp(hi, THREE.MathUtils.clamp(h / 40, 0, 0.5)).lerp(rock, THREE.MathUtils.clamp((slope - 0.35) * 2, 0, 0.85))
      col.set([_c.r, _c.g, _c.b], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.computeVertexNormals()
    return g
  }, [world, id])
  const street = useMemo(() => (id === 'city' || id === 'night' ? streetTexture(night) : null), [id, night])
  const water = useMemo(() => {
    if (id !== 'harbor') return null
    const c = document.createElement('canvas'); c.width = c.height = 256
    const g = c.getContext('2d')!
    const img = g.createImageData(256, 256)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const nx = Math.sin((x / 256) * Math.PI * 8 + Math.sin((y / 256) * Math.PI * 6) * 1.5) * 0.5, ny = Math.cos((y / 256) * Math.PI * 10 + Math.sin((x / 256) * Math.PI * 4)) * 0.5
      const i = (y * 256 + x) * 4
      img.data[i] = 128 + nx * 60; img.data[i + 1] = 128 + ny * 60; img.data[i + 2] = 255; img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(120, 120)
    return t
  }, [id])
  useFrame((_, dt) => { if (water) { water.offset.x += dt * 0.004; water.offset.y += dt * 0.0025 } })
  useEffect(() => () => { geo?.dispose(); street?.dispose(); water?.dispose() }, [geo, street, water])

  return (
    <group>
      {geo && <mesh geometry={geo} receiveShadow><meshStandardMaterial vertexColors roughness={0.96} metalness={0} /></mesh>}
      {street && (
        <>
          <mesh rotation-x={-Math.PI / 2} receiveShadow><planeGeometry args={[world.half * 2, world.half * 2]} /><meshStandardMaterial map={street} roughness={0.92} /></mesh>
          <mesh rotation-x={-Math.PI / 2} position-y={-0.05}><planeGeometry args={[8000, 8000]} /><meshStandardMaterial color={night ? '#14171c' : '#5b6066'} roughness={1} /></mesh>
        </>
      )}
      {water && (
        <>
          <mesh rotation-x={-Math.PI / 2} position-y={0} receiveShadow><planeGeometry args={[8000, 8000]} /><meshStandardMaterial color="#24566f" roughness={0.18} metalness={0.25} normalMap={water} normalScale={new THREE.Vector2(0.35, 0.35)} /></mesh>
          <mesh position={[-420, -1.75, 0]} receiveShadow castShadow><boxGeometry args={[760, 8.5, 1600]} /><meshStandardMaterial color="#9a9890" roughness={0.9} /></mesh>
          <mesh position={[-40.3, 2.52, 0]}><boxGeometry args={[0.6, 0.06, 1600]} /><meshStandardMaterial color="#e2b622" roughness={0.6} /></mesh>
        </>
      )}
    </group>
  )
}

// ───────────────────────────── structures ─────────────────────────────

function buildingMaterial(night: boolean) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.05 })
  m.onBeforeCompile = sh => {
    sh.uniforms.uNight = { value: night ? 1 : 0 }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vON;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvON = normal;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWP; varying vec3 vON; uniform float uNight;
        float hsh(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wall = 1.0 - step(0.5, abs(vON.y));
        float onX = step(0.5, abs(vON.x));
        float u = mix(vWP.x, vWP.z, onX);
        vec2 cell = vec2(u / 3.2, (vWP.y - 1.2) / 3.6);
        vec2 fc = fract(cell);
        float win = wall * step(0.2, fc.x) * step(fc.x, 0.8) * step(0.3, fc.y) * step(fc.y, 0.82) * step(1.0, cell.y);
        float plane = floor(mix(vWP.z, vWP.x, onX) * 0.5) + vON.x * 3.0 + vON.z * 7.0;
        float lit = step(0.56, hsh(vec3(floor(cell), plane)));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.28 + vec3(0.05, 0.08, 0.12), win);
        diffuseColor.rgb *= mix(0.78, 1.0, wall);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uNight * win * lit * vec3(1.0, 0.76, 0.42) * 1.25;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.25, win);')
  }
  return m
}

function useInstancedBoxes(list: { min: THREE.Vector3; max: THREE.Vector3; color: string }[]) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), [])
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    list.forEach((b, i) => {
      _p.set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2)
      _s.set(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
      _m.compose(_p, _q.identity(), _s)
      m.setMatrixAt(i, _m)
      m.setColorAt(i, _c.set(b.color))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [list])
  return { ref, geo }
}

export function Structures({ world, night, shadows }: { world: World; night: boolean; shadows: boolean }) {
  const bMat = useMemo(() => buildingMaterial(night), [night])
  const boxMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.15 }), [])
  const b = useInstancedBoxes(world.buildings)
  const x = useInstancedBoxes(world.boxes)
  useEffect(() => () => { bMat.dispose(); boxMat.dispose() }, [bMat, boxMat])
  return (
    <>
      {world.buildings.length > 0 && <instancedMesh ref={b.ref} args={[b.geo, bMat, world.buildings.length]} castShadow={shadows} receiveShadow frustumCulled={false} />}
      {world.boxes.length > 0 && <instancedMesh ref={x.ref} args={[x.geo, boxMat, world.boxes.length]} castShadow={shadows} receiveShadow frustumCulled={false} />}
    </>
  )
}

export function Trees({ world, shadows }: { world: World; shadows: boolean }) {
  const forest = world.env.id === 'forest'
  const crown = useRef<THREE.InstancedMesh>(null)
  const trunk = useRef<THREE.InstancedMesh>(null)
  const geos = useMemo(() => ({
    crown: forest ? new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0) : new THREE.IcosahedronGeometry(1, 1),
    trunk: new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0),
  }), [forest])
  const mats = useMemo(() => ({
    crown: new THREE.MeshStandardMaterial({ color: forest ? '#2f4d2c' : '#7d7a4a', roughness: 0.95, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: '#4d3826', roughness: 1 }),
  }), [forest])
  useLayoutEffect(() => {
    const c = crown.current, t = trunk.current
    if (!c || !t) return
    world.trees.forEach((tr, i) => {
      const k = ((i * 2654435761) % 1000) / 1000
      if (forest) {
        _m.compose(_p.set(tr.x, tr.y + tr.h * 0.25, tr.z), _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * 6), _s.set(tr.r * 1.15, tr.h * 0.8, tr.r * 1.15))
        c.setColorAt(i, _c.set('#2f4d2c').offsetHSL((k - 0.5) * 0.04, 0, (k - 0.5) * 0.08))
      } else {
        _m.compose(_p.set(tr.x, tr.y + tr.h * 0.45, tr.z), _q.identity(), _s.set(tr.r, tr.h * 0.42, tr.r))
        c.setColorAt(i, _c.set('#7d7a4a').offsetHSL((k - 0.5) * 0.05, 0, (k - 0.5) * 0.1))
      }
      c.setMatrixAt(i, _m)
      _m.compose(_p.set(tr.x, tr.y, tr.z), _q.identity(), _s.set(1, tr.h * (forest ? 0.35 : 0.2), 1))
      t.setMatrixAt(i, _m)
    })
    c.instanceMatrix.needsUpdate = true; t.instanceMatrix.needsUpdate = true
    if (c.instanceColor) c.instanceColor.needsUpdate = true
    c.computeBoundingSphere(); t.computeBoundingSphere()
  }, [world, forest])
  if (!world.trees.length) return null
  return (
    <>
      <instancedMesh ref={crown} args={[geos.crown, mats.crown, world.trees.length]} castShadow={shadows} receiveShadow frustumCulled={false} />
      <instancedMesh ref={trunk} args={[geos.trunk, mats.trunk, world.trees.length]} castShadow={shadows} frustumCulled={false} />
    </>
  )
}

export function Lamps({ world, game }: { world: World; game: Game }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const poles = useRef<THREE.InstancedMesh>(null)
  const lights = useRef<(THREE.PointLight | null)[]>([])
  useLayoutEffect(() => {
    world.lamps.forEach((l, i) => {
      ref.current?.setMatrixAt(i, _m.compose(_p.set(l.x, l.y + 0.2, l.z), _q.identity(), _s.set(0.5, 0.5, 0.5)))
      poles.current?.setMatrixAt(i, _m.compose(_p.set(l.x, 0, l.z), _q.identity(), _s.set(1, l.y, 1)))
    })
    if (ref.current) { ref.current.instanceMatrix.needsUpdate = true; ref.current.computeBoundingSphere() }
    if (poles.current) { poles.current.instanceMatrix.needsUpdate = true; poles.current.computeBoundingSphere() }
  }, [world])
  const clock = useRef(0)
  useFrame((_, dt) => {
    clock.current -= dt
    if (clock.current > 0) return
    clock.current = 0.5
    const p = game.craft.pos
    const near = [...world.lamps].sort((a, b) => a.distanceToSquared(p) - b.distanceToSquared(p)).slice(0, 4)
    lights.current.forEach((l, i) => { if (l && near[i]) l.position.copy(near[i]) })
  })
  const geoPole = useMemo(() => new THREE.CylinderGeometry(0.08, 0.1, 1, 6).translate(0, 0.5, 0), [])
  if (!world.lamps.length) return null
  return (
    <>
      <instancedMesh ref={ref} args={[undefined, undefined, world.lamps.length]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial color="#ffd9a0" toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={poles} args={[geoPole, undefined, world.lamps.length]} frustumCulled={false}><meshStandardMaterial color="#2a2d33" /></instancedMesh>
      {[0, 1, 2, 3].map(i => <pointLight key={i} ref={el => { lights.current[i] = el }} color="#ffcf8a" intensity={60} distance={45} decay={1.6} />)}
    </>
  )
}

export function LaunchPad({ at, size = 3 }: { at: THREE.Vector3; size?: number }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256
    const g = c.getContext('2d')!
    g.fillStyle = '#2b3138'; g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill()
    g.strokeStyle = '#ff6a2b'; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2); g.stroke()
    g.fillStyle = '#e9edf1'; g.font = 'bold 140px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', 128, 136)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  return (
    <mesh position={[at.x, at.y + 0.03, at.z]} rotation-x={-Math.PI / 2} receiveShadow>
      <circleGeometry args={[size, 48]} />
      <meshStandardMaterial map={tex} transparent roughness={0.8} polygonOffset polygonOffsetFactor={-2} />
    </mesh>
  )
}

// ───────────────────────────── player ─────────────────────────────

export function Player({ game, spec, geo, visible }: { game: Game; spec: DroneSpec; geo: DroneGeometry; visible: boolean }) {
  const ref = useRef<THREE.Group>(null)
  const q = useMemo(() => new THREE.Quaternion(), [])
  useFrame(() => {
    const g = ref.current
    if (!g) return
    g.position.copy(game.craft.pos)
    g.quaternion.copy(game.craft.orientation(q))
    g.visible = visible && game.craft.alive
  })
  return (
    <group ref={ref}>
      <DroneModel spec={spec} geometry={geo} spin={45} />
    </group>
  )
}

/** Soft dark blob under the drone: the single best depth cue for hovering. */
export function GroundShadow({ game }: { game: Game }) {
  const ref = useRef<THREE.Mesh>(null)
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d')!
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    r.addColorStop(0, 'rgba(0,0,0,0.75)'); r.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = r; g.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  }, [])
  useFrame(() => {
    const m = ref.current
    if (!m) return
    const p = game.craft.pos
    const g = groundAt(game.world, p.x, p.z)
    const agl = p.y - g
    m.position.set(p.x, g + 0.04, p.z)
    const s = game.span * (1.1 + agl * 0.02)
    m.scale.set(s, s, s)
    ;(m.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(1 - agl / 35, 0, 0.8)
    m.visible = game.craft.alive
  })
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} renderOrder={1}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-4} />
    </mesh>
  )
}

export function Searchlight({ game }: { game: Game }) {
  const ref = useRef<THREE.SpotLight>(null)
  const target = useMemo(() => new THREE.Object3D(), [])
  const fwd = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const l = ref.current
    if (!l) return
    const on = game.sysOn('searchlight')
    l.visible = on
    if (!on) return
    l.position.copy(game.craft.pos)
    // the light follows the gimbal, like the camera
    game.craft.forward(fwd)
    const yaw = Math.atan2(-fwd.z, fwd.x), pitch = game.aimPitch - 0.15
    target.position.set(l.position.x + Math.cos(pitch) * Math.cos(yaw) * 30, l.position.y + Math.sin(pitch) * 30, l.position.z - Math.cos(pitch) * Math.sin(yaw) * 30)
    target.updateMatrixWorld()
  })
  if (!game.has('searchlight')) return null
  return (
    <>
      <primitive object={target} />
      <spotLight ref={ref} target={target} color="#fff6e0" intensity={900} distance={260} angle={0.32} penumbra={0.55} decay={1.4} />
    </>
  )
}

// ───────────────────────────── entities ─────────────────────────────

const enemyCache = new Map<string, { spec: DroneSpec; geo: DroneGeometry }>()
function enemyModel(kind: 'hostile' | 'rogue' | 'micro') {
  let m = enemyCache.get(kind)
  if (m) return m
  const size = kind === 'micro' ? 0.36 : 0.9
  const spec = newDesign('quad_x', size, size, kind)
  spec.livery = kind === 'hostile' ? { primary: '#3a1517', secondary: '#1a1c20', accent: '#ff3b3b', finish: 'matte', pattern: 'hazard' }
    : kind === 'rogue' ? { primary: '#e7c52f', secondary: '#25282d', accent: '#111111', finish: 'satin', pattern: 'stripe' }
      : { primary: '#2bd49a', secondary: '#0f1d18', accent: '#e7fff5', finish: 'gloss', pattern: 'split' }
  m = { spec, geo: buildGeometry(spec) }
  enemyCache.set(kind, m)
  return m
}

function targetTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d')!
  for (let i = 5; i >= 1; i--) { g.fillStyle = i % 2 ? '#e8e8e8' : '#d63a2f'; g.beginPath(); g.arc(64, 64, i * 12.5, 0, Math.PI * 2); g.fill() }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

function EntityView({ e, game, thermal }: { e: Entity; game: Game; thermal: boolean }) {
  const ref = useRef<THREE.Group>(null)
  const glow = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const g = ref.current
    if (!g) return
    g.position.copy(e.pos)
    g.rotation.set(0, e.yaw, 0)
    if (e.state === 'falling') { g.rotation.z = Math.sin(game.t * 9 + e.id) * 0.5; g.rotation.x = 0.4 }
    if (e.model === 'truck' && e.state === 'dead') g.rotation.z = 0.08
    g.visible = !(e.state === 'delivered') && !(e.kind === 'micro' && e.state !== 'active') && !(e.model === 'balloon' && e.state === 'dead')
    if (glow.current) glow.current.visible = thermal && e.state === 'active' && e.heat > 0.3
  })
  const dead = e.state === 'dead'
  const body = dead ? '#1b1b1b' : e.color
  const tex = useMemo(() => (e.model === 'board' ? targetTexture() : null), [e.model])
  let inner: ReactNode = null
  if (e.model === 'truck') inner = (
    <group>
      <mesh position={[-0.4, 1.0, 0]} castShadow receiveShadow><boxGeometry args={[3.4, 1.5, 2.1]} /><meshStandardMaterial color={body} roughness={0.8} /></mesh>
      <mesh position={[1.75, 0.85, 0]} castShadow><boxGeometry args={[1.3, 1.2, 2.0]} /><meshStandardMaterial color={dead ? '#151515' : '#56603c'} roughness={0.7} /></mesh>
      <mesh position={[2.2, 1.1, 0]}><boxGeometry args={[0.45, 0.5, 1.7]} /><meshStandardMaterial color={dead ? '#0a0a0a' : '#9fc6e0'} roughness={0.2} metalness={0.3} /></mesh>
      {[-1.4, 0.2, 1.8].map(x => [-1, 1].map(s => <mesh key={`${x}${s}`} position={[x, 0.42, s * 1.0]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.42, 0.42, 0.3, 12]} /><meshStandardMaterial color="#111" /></mesh>))}
    </group>
  )
  else if (e.model === 'bunker') inner = (
    <group>
      <mesh position={[0, 1.4, 0]} castShadow receiveShadow><boxGeometry args={[6, 2.8, 6]} /><meshStandardMaterial color={body} roughness={0.95} /></mesh>
      <mesh position={[3.01, 1.8, 0]}><boxGeometry args={[0.05, 0.4, 3.2]} /><meshBasicMaterial color="#090909" /></mesh>
    </group>
  )
  else if (e.model === 'board') inner = (
    <group rotation-y={Math.PI / 2}>
      <mesh position={[0, 1.5, 0]} castShadow><boxGeometry args={[0.15, 3, 0.15]} /><meshStandardMaterial color="#5a4632" /></mesh>
      <mesh position={[0, 2.4, 0.09]}><circleGeometry args={[1.3, 32]} /><meshStandardMaterial map={tex} side={THREE.DoubleSide} /></mesh>
    </group>
  )
  else if (e.model === 'balloon') inner = (
    <group>
      <mesh castShadow><sphereGeometry args={[e.radius, 20, 16]} /><meshStandardMaterial color={e.color} roughness={0.35} metalness={0.05} /></mesh>
      <mesh position={[0, -e.radius - 2, 0]}><cylinderGeometry args={[0.01, 0.01, 4, 3]} /><meshBasicMaterial color="#ddd" /></mesh>
      {e.netted && <mesh><sphereGeometry args={[e.radius * 1.15, 10, 8]} /><meshBasicMaterial color="#d9d2b0" wireframe /></mesh>}
    </group>
  )
  else if (e.model === 'crate') {
    const s = e.radius * 2
    inner = (
      <group>
        <mesh castShadow receiveShadow><boxGeometry args={[s, s, s]} /><meshStandardMaterial color={e.broken ? '#8a6a45' : e.color} roughness={0.85} /></mesh>
        <mesh><boxGeometry args={[s * 1.01, s * 0.12, s * 1.01]} /><meshStandardMaterial color="#3a3f46" roughness={0.6} /></mesh>
        <mesh><boxGeometry args={[s * 0.12, s * 1.01, s * 1.01]} /><meshStandardMaterial color="#3a3f46" roughness={0.6} /></mesh>
      </group>
    )
  } else if (e.model === 'drone' || e.model === 'micro') {
    const m = enemyModel(e.kind === 'hostile' ? 'hostile' : e.kind === 'rogue' ? 'rogue' : 'micro')
    inner = (
      <group>
        <DroneModel spec={m.spec} geometry={m.geo} spin={e.state === 'active' ? 50 : 0} castShadow={false} />
        {e.netted && <mesh><sphereGeometry args={[e.radius * 1.5, 10, 8]} /><meshBasicMaterial color="#d9d2b0" wireframe /></mesh>}
      </group>
    )
  }
  return (
    <group ref={ref}>
      {inner}
      <mesh ref={glow} visible={false}>
        <sphereGeometry args={[Math.max(e.radius * 1.1, 0.4), 12, 10]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} toneMapped={false} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}

export function EntityLayer({ game, version, thermal }: { game: Game; version: number; thermal: boolean }) {
  void version
  return <>{game.entities.map(e => <EntityView key={e.id} e={e} game={game} thermal={thermal} />)}</>
}

// ───────────────────────────── projectiles & effects ─────────────────────────────

export function Projectiles({ game }: { game: Game }) {
  const tracer = useRef<THREE.InstancedMesh>(null)
  const ord = useRef<THREE.InstancedMesh>(null)
  const nets = useRef<THREE.InstancedMesh>(null)
  const N = 320
  const geos = useMemo(() => ({
    tracer: new THREE.BoxGeometry(1, 1, 1),
    ord: new THREE.CapsuleGeometry(0.09, 0.42, 4, 8).rotateZ(Math.PI / 2),
    net: new THREE.TorusGeometry(1, 0.03, 4, 16),
  }), [])
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    let nt = 0, no = 0, nn = 0
    for (const p of game.projectiles) {
      if (p.kind === 'bullet' || p.kind === 'enemy') {
        if (nt >= N || !tracer.current) continue
        const sp = p.vel.length()
        v.copy(p.vel).divideScalar(sp || 1)
        _q.setFromUnitVectors(X, v)
        _m.compose(_p.copy(p.pos).addScaledVector(v, -1.2), _q, _s.set(Math.min(sp * 0.012, 3.2), 0.07, 0.07))
        tracer.current.setMatrixAt(nt, _m)
        tracer.current.setColorAt(nt, _c.set(p.kind === 'bullet' ? '#ffb347' : '#ff3b3b'))
        nt++
      } else if (p.kind === 'net') {
        if (!nets.current || nn >= 32) continue
        const r = 0.3 + Math.min(1, p.age * 3) * 2
        v.copy(p.vel).normalize()
        _q.setFromUnitVectors(Zv, v)
        _m.compose(p.pos, _q, _s.set(r, r, r))
        nets.current.setMatrixAt(nn++, _m)
      } else {
        if (!ord.current || no >= 64) continue
        v.copy(p.vel).normalize()
        _q.setFromUnitVectors(X, v.lengthSq() > 0 ? v : X)
        const k = p.kind === 'missile' ? 1.6 : p.kind === 'pod' ? 2.2 : 1.2
        _m.compose(p.pos, _q, _s.set(k, k, k))
        ord.current.setMatrixAt(no, _m)
        ord.current.setColorAt(no, _c.set(p.kind === 'missile' ? '#e9edf1' : p.kind === 'pod' ? '#ff6a2b' : '#4b5320'))
        no++
      }
    }
    for (const [m, n] of [[tracer.current, nt], [ord.current, no], [nets.current, nn]] as const) {
      if (!m) continue
      m.count = n
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
  })
  return (
    <>
      <instancedMesh ref={tracer} args={[geos.tracer, undefined, N]} frustumCulled={false}><meshBasicMaterial toneMapped={false} /></instancedMesh>
      <instancedMesh ref={ord} args={[geos.ord, undefined, 64]} frustumCulled={false} castShadow><meshStandardMaterial roughness={0.5} metalness={0.3} /></instancedMesh>
      <instancedMesh ref={nets} args={[geos.net, undefined, 32]} frustumCulled={false}><meshBasicMaterial color="#e6dfbd" wireframe /></instancedMesh>
    </>
  )
}

export function Effects({ game }: { game: Game }) {
  const glow = useRef<THREE.InstancedMesh>(null)
  const smoke = useRef<THREE.InstancedMesh>(null)
  const emp = useRef<THREE.Mesh>(null)
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1, 2), [])
  useFrame(() => {
    let ng = 0, ns = 0
    let empOn = false
    for (const f of game.effects) {
      if (f.age < 0) continue
      const u = f.age / f.dur
      if (f.kind === 'boom' || f.kind === 'flash' || f.kind === 'spark') {
        if (!glow.current || ng >= 96) continue
        const s = f.kind === 'boom' ? f.size * (0.3 + 0.9 * Math.sqrt(u)) : f.size * (1 - u * 0.5)
        _m.compose(f.pos, _q.identity(), _s.set(s, s, s))
        glow.current.setMatrixAt(ng, _m)
        const fade = (1 - u) ** 1.5
        _c.set(f.kind === 'spark' ? '#ffe2a0' : '#ff9a3c').multiplyScalar(fade * (f.kind === 'boom' ? 2.2 : 3))
        glow.current.setColorAt(ng++, _c)
      } else if (f.kind === 'emp' && emp.current) {
        empOn = true
        const s = f.size * Math.min(1, u * 1.6)
        emp.current.position.copy(f.pos)
        emp.current.scale.setScalar(s)
        ;(emp.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - u)
      } else {
        if (!smoke.current || ns >= 160) continue
        const grow = f.kind === 'trail' ? 0.4 + u * 1.6 : f.kind === 'splash' ? 0.5 + u : 0.4 + Math.sqrt(u) * 1.1
        const shrink = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1
        const s = f.size * grow * shrink
        _m.compose(f.pos, _q.identity(), _s.set(s, s * (f.kind === 'splash' ? 0.6 : 1), s))
        smoke.current.setMatrixAt(ns, _m)
        _c.set(f.kind === 'splash' ? '#e8f4ff' : f.kind === 'dust' ? '#b9a07c' : f.kind === 'trail' ? '#d8d8d8' : '#8d9095')
        smoke.current.setColorAt(ns++, _c)
      }
    }
    for (const [m, n] of [[glow.current, ng], [smoke.current, ns]] as const) {
      if (!m) continue
      m.count = n
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
    if (emp.current) emp.current.visible = empOn
  })
  return (
    <>
      <instancedMesh ref={glow} args={[geo, undefined, 96]} frustumCulled={false}>
        <meshBasicMaterial transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={smoke} args={[geo, undefined, 160]} frustumCulled={false}>
        <meshLambertMaterial transparent opacity={0.55} depthWrite={false} />
      </instancedMesh>
      <mesh ref={emp} visible={false}>
        <sphereGeometry args={[1, 24, 16]} />
        <meshBasicMaterial color="#7fd8ff" wireframe transparent opacity={0.5} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
    </>
  )
}

// ───────────────────────────── objectives ─────────────────────────────

function RingView({ game, i }: { game: Game; i: number }) {
  const r = game.rings[i]
  const ref = useRef<THREE.Mesh>(null)
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(Zv, r.normal), [r])
  useFrame(({ clock }) => {
    const m = ref.current
    if (!m) return
    const mat = m.material as THREE.MeshStandardMaterial
    const next = i === game.nextRing, soon = i === game.nextRing + 1
    m.visible = !r.passed
    if (next) {
      const pulse = 0.75 + 0.25 * Math.sin(clock.elapsedTime * 6)
      mat.color.set('#ff6a2b'); mat.emissive.set('#ff6a2b'); mat.emissiveIntensity = 1.6 * pulse; mat.opacity = 1
    } else {
      mat.color.set(soon ? '#ffd2b8' : '#ffffff'); mat.emissive.set('#ffffff'); mat.emissiveIntensity = soon ? 0.35 : 0.12; mat.opacity = soon ? 0.75 : 0.32
    }
  })
  return (
    <mesh ref={ref} position={r.pos} quaternion={q}>
      <torusGeometry args={[r.radius, Math.max(r.radius * 0.07, 0.12), 12, 56]} />
      <meshStandardMaterial transparent toneMapped={false} roughness={0.4} />
    </mesh>
  )
}

function ZoneView({ game, i }: { game: Game; i: number }) {
  const z = game.zones[i]
  const col = useRef<THREE.Mesh>(null)
  const prog = useRef<THREE.Mesh>(null)
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uCol: { value: new THREE.Color('#5cb3ff') }, uT: { value: 0 } },
    vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uCol; uniform float uT; varying float vY; void main(){ float a = (1.0 - vY) * 0.45 * (0.7 + 0.3 * sin(uT * 3.0 + vY * 12.0)); gl_FragColor = vec4(uCol * a, a); }',
  }), [])
  const last = useRef(-1)
  useFrame(({ clock }) => {
    mat.uniforms.uT.value = clock.elapsedTime
    mat.uniforms.uCol.value.set(z.done ? '#3fd69b' : '#5cb3ff')
    if (prog.current && Math.abs(z.progress - last.current) > 0.004) {
      last.current = z.progress
      const p = Math.max(z.progress, 0.001)
      prog.current.geometry.dispose()
      prog.current.geometry = new THREE.RingGeometry(z.radius * 0.92, z.radius, 64, 1, 0, p * Math.PI * 2)
    }
  })
  return (
    <group position={z.pos}>
      <mesh ref={col} position-y={30} material={mat}><cylinderGeometry args={[z.radius, z.radius, 60, 48, 1, true]} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.3}><ringGeometry args={[z.radius * 0.97, z.radius, 64]} /><meshBasicMaterial color="#5cb3ff" transparent opacity={0.5} toneMapped={false} /></mesh>
      <mesh ref={prog} rotation-x={-Math.PI / 2} position-y={0.35}><ringGeometry args={[z.radius * 0.92, z.radius, 64]} /><meshBasicMaterial color="#3fd69b" toneMapped={false} /></mesh>
    </group>
  )
}

export function Objectives({ game }: { game: Game }) {
  return (
    <>
      {game.rings.map((_, i) => <RingView key={i} game={game} i={i} />)}
      {game.zones.map((_, i) => <ZoneView key={i} game={game} i={i} />)}
      {game.pads.map((p, i) => (
        <group key={i} position={p.pos}>
          <LaunchPad at={new THREE.Vector3(0, 0, 0)} size={p.radius} />
          <mesh position-y={0.2} rotation-x={-Math.PI / 2}><ringGeometry args={[p.radius * 0.98, p.radius * 1.08, 64]} /><meshBasicMaterial color="#3fd69b" toneMapped={false} /></mesh>
          <mesh position-y={12}><cylinderGeometry args={[0.06, 0.06, 24, 6]} /><meshBasicMaterial color="#3fd69b" transparent opacity={0.6} toneMapped={false} /></mesh>
        </group>
      ))}
    </>
  )
}

export function Rope({ game }: { game: Game }) {
  const ref = useRef<THREE.Line>(null)
  const geo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)); return g }, [])
  const line = useMemo(() => new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#2b2b2b' })), [geo])
  useFrame(() => {
    const e = game.carried
    line.visible = !!e
    if (!e) return
    const a = game.bodyToWorld(new THREE.Vector3(0, -game.span * 0.1, 0))
    const arr = geo.attributes.position.array as Float32Array
    arr.set([a.x, a.y, a.z, e.pos.x, e.pos.y + e.radius, e.pos.z])
    geo.attributes.position.needsUpdate = true
    geo.computeBoundingSphere()
  })
  return <primitive ref={ref} object={line} />
}

export function LaserBeam({ game }: { game: Game }) {
  const ref = useRef<THREE.Mesh>(null)
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const m = ref.current
    if (!m) return
    m.visible = game.laser.on
    if (!game.laser.on) return
    v.subVectors(game.laser.to, game.laser.from)
    const L = v.length()
    m.position.copy(game.laser.from).addScaledVector(v, 0.5)
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize())
    m.scale.set(1, L, 1)
  })
  return (
    <mesh ref={ref} visible={false}>
      <cylinderGeometry args={[0.03, 0.03, 1, 6, 1, true]} />
      <meshBasicMaterial color="#ff2b4a" transparent opacity={0.85} blending={THREE.AdditiveBlending} toneMapped={false} depthWrite={false} />
    </mesh>
  )
}

/** The live Avia cloud, drawn in the world as the drone flies. */
export function LidarCloud({ game }: { game: Game }) {
  const L = game.lidar
  const geo = useMemo(() => {
    if (!L) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(L.pts, 3))
    g.setAttribute('color', new THREE.BufferAttribute(L.col, 3))
    g.setDrawRange(0, 0)
    return g
  }, [L])
  const ref = useRef<THREE.Points>(null)
  useFrame(() => {
    if (!L || !geo || !ref.current) return
    ref.current.visible = L.on && L.count > 0
    geo.setDrawRange(0, L.count)
    ;(geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(geo.attributes.color as THREE.BufferAttribute).needsUpdate = true
  })
  if (!geo) return null
  return (
    <points ref={ref} geometry={geo} frustumCulled={false}>
      <pointsMaterial size={2.2} sizeAttenuation={false} vertexColors transparent opacity={0.9} depthWrite={false} toneMapped={false} />
    </points>
  )
}
