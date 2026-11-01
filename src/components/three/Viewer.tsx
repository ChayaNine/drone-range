import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, ContactShadows, Environment, Lightformer } from '@react-three/drei'
import type { DroneSpec } from '../../engine/types'
import { DroneModel, useDroneGeometry, Z_UP_TO_Y_UP } from './DroneModel'
import { mergeDrone, type DroneGeometry } from '../../engine/geometry'
import { sampleSurface } from '../../engine/pointcloud'
import { turbo } from './turbo'
import { tuneRenderer, useOnScreen } from './perf'

export function StudioLights({ intensity = 1 }: { intensity?: number }) {
  return (
    <>
      <ambientLight intensity={0.35 * intensity} />
      <directionalLight position={[3, 5, 2]} intensity={1.6 * intensity} castShadow shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-4, 2, -3]} intensity={0.5 * intensity} color="#9fc3ff" />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 5, -2]} scale={[8, 3, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#ffd9c2" position={[-5, 1, 2]} rotation-y={Math.PI / 2} scale={[6, 2, 1]} />
        <Lightformer form="rect" intensity={1.0} color="#b9d7ff" position={[5, 1, 1]} rotation-y={-Math.PI / 2} scale={[6, 2, 1]} />
        <Lightformer form="ring" intensity={0.6} position={[0, -3, 0]} rotation-x={Math.PI / 2} scale={4} />
      </Environment>
    </>
  )
}

/** Frames the camera on the model's bounding sphere whenever the model's size changes. */
function Frame({ radius, elevation = 0.42 }: { radius: number; elevation?: number }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update: () => void } | null }
  const last = useRef(0)
  useEffect(() => {
    if (Math.abs(radius - last.current) / Math.max(radius, 1e-3) < 0.15) return
    last.current = radius
    const d = (radius / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * 1.05
    camera.position.set(d * Math.cos(elevation) * 0.75, d * Math.sin(elevation), d * Math.cos(elevation) * 0.66)
    camera.near = Math.max(radius / 200, 0.002)
    camera.far = radius * 200
    camera.updateProjectionMatrix()
    controls?.target.set(0, 0, 0)
    controls?.update()
  }, [radius, camera, controls, elevation])
  return null
}

/** The signature moment: the drone is scanned into existence by a growing point cloud. */
export function ScanReveal({ geometry, onDone, duration = 1.3 }: { geometry: DroneGeometry; onDone?: () => void; duration?: number }) {
  const { pts, cols, n } = useMemo(() => {
    const merged = mergeDrone(geometry)
    const N = 9000
    const p = sampleSurface(merged, N, 11)
    merged.dispose()
    // Order points the way a non-repetitive sensor fills its field of view: centre first, then out,
    // with petals of a rosette breaking up the wipe.
    const idx = [...Array(N).keys()]
    const key = (i: number) => {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]
      const r = Math.hypot(x, y) / Math.max(geometry.size.x, geometry.size.y, 1e-3)
      const a = Math.atan2(y, x)
      return r + 0.12 * Math.sin(a * 5 + z * 20) + 0.08 * ((i * 2654435761) % 1000) / 1000
    }
    idx.sort((a, b) => key(a) - key(b))
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3)
    const zmin = geometry.bbox.min.z, zr = Math.max(geometry.size.z, 1e-3)
    idx.forEach((s, d) => {
      pos[d * 3] = p[s * 3]; pos[d * 3 + 1] = p[s * 3 + 1]; pos[d * 3 + 2] = p[s * 3 + 2]
      const [r, g, b] = turbo(0.15 + 0.8 * ((p[s * 3 + 2] - zmin) / zr))
      col[d * 3] = r; col[d * 3 + 1] = g; col[d * 3 + 2] = b
    })
    return { pts: pos, cols: col, n: N }
  }, [geometry])
  const ref = useRef<THREE.Points>(null)
  const t = useRef(0)
  const done = useRef(false)
  useFrame((_, dt) => {
    t.current += Math.min(dt, 0.25)
    const g = ref.current?.geometry
    if (!g) return
    const k = Math.min(1, t.current / duration)
    g.setDrawRange(0, Math.floor(n * k * k * (3 - 2 * k)))
    const m = ref.current!.material as THREE.PointsMaterial
    if (k >= 1) {
      m.opacity = Math.max(0, 1 - (t.current - duration) / 0.5)
      if (!done.current) { done.current = true; onDone?.() }
    }
  })
  const size = Math.max(geometry.size.x, geometry.size.y)
  return (
    <points ref={ref} rotation={Z_UP_TO_Y_UP}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pts, 3]} />
        <bufferAttribute attach="attributes-color" args={[cols, 3]} />
      </bufferGeometry>
      <pointsMaterial size={size * 0.008} vertexColors transparent opacity={1} depthWrite={false} sizeAttenuation />
    </points>
  )
}

/** A fresh scan for every new drone: remounting restarts the reveal from an empty cloud. */
const revealIds = new WeakMap<object, number>()
let revealSeq = 0
const revealKey = (g: object) => { let k = revealIds.get(g); if (k == null) { k = ++revealSeq; revealIds.set(g, k) } return k }

export interface ViewerProps {
  spec: DroneSpec
  height?: number | string
  autoRotate?: boolean
  spin?: number
  reveal?: boolean
  showCg?: { cg: THREE.Vector3; thrust: THREE.Vector3; ok: boolean } | null
  children?: ReactNode
  controls?: boolean
}

export function DroneViewer({ spec, height = 420, autoRotate = true, spin = 0, reveal = false, showCg, children, controls = true }: ViewerProps) {
  const geometry = useDroneGeometry(spec)
  const radius = Math.max(geometry.size.length() / 2, 0.05)
  const [shown, setShown] = useState(!reveal)
  useEffect(() => { if (reveal) setShown(false) }, [reveal, geometry])
  const box = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(box)
  return (
    <div className="scene grid-bg" style={{ height }} ref={box}>
      <Canvas shadows="percentage" dpr={[1, 2]} camera={{ fov: 32, position: [1, 0.6, 1] }} gl={{ antialias: true, preserveDrawingBuffer: true }}
        frameloop={onScreen ? 'always' : 'never'} onCreated={({ gl }) => tuneRenderer(gl)}>
        <Suspense fallback={null}>
          <StudioLights />
          <DroneModel spec={spec} geometry={geometry} spin={spin} visible={shown} />
          {reveal && <ScanReveal key={revealKey(geometry)} geometry={geometry} onDone={() => setShown(true)} />}
          {showCg && <CgMarker cg={showCg.cg} thrust={showCg.thrust} ok={showCg.ok} radius={radius} />}
          <ContactShadows position={[0, -geometry.size.z / 2 - radius * 0.02, 0]} opacity={0.5} scale={radius * 5} blur={2.4} far={radius * 2} resolution={256} />
          {children}
        </Suspense>
        {controls && <OrbitControls makeDefault enableDamping autoRotate={autoRotate} autoRotateSpeed={0.8} minDistance={radius * 0.6} maxDistance={radius * 12} />}
        <Frame radius={radius} />
      </Canvas>
    </div>
  )
}

/** Centre of gravity (ball) against centre of lift (ring). The visual half of the balance bar. */
function CgMarker({ cg, thrust, ok, radius }: { cg: THREE.Vector3; thrust: THREE.Vector3; ok: boolean; radius: number }) {
  const r = radius * 0.05
  const color = ok ? '#3fd69b' : '#ff5466'
  return (
    <group rotation={Z_UP_TO_Y_UP}>
      <mesh position={[thrust.x, thrust.y, thrust.z]}>
        <torusGeometry args={[r * 2.2, r * 0.22, 8, 40]} />
        <meshBasicMaterial color="#ff6a2b" depthTest={false} transparent opacity={0.9} />
      </mesh>
      <mesh position={[cg.x, cg.y, cg.z]}>
        <sphereGeometry args={[r, 18, 12]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array([thrust.x, thrust.y, thrust.z, cg.x, cg.y, cg.z]), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} depthTest={false} />
      </line>
    </group>
  )
}
