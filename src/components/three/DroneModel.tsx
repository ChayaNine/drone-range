/**
 * Renders a drone spec in a Y-up R3F scene. The engine works in Z-up (X fwd, Y left), so the
 * whole model is wrapped in a -90° X rotation: model +Z becomes world +Y, model +Y becomes -Z.
 */
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import type { DroneSpec } from '../../engine/types'
import { buildGeometry, mergeByMaterial, type DroneGeometry, type MatKey } from '../../engine/geometry'
import { droneMaterials, updateDroneMaterials } from './materials'

export const Z_UP_TO_Y_UP: [number, number, number] = [-Math.PI / 2, 0, 0]

export function useDroneGeometry(spec: DroneSpec): DroneGeometry {
  // Rebuild only when something that changes the shape changes.
  const key = JSON.stringify([spec.layout, spec.envelope, spec.ratios, spec.rotorDiameterOverride, spec.body, spec.internals.propBlades,
    spec.internals.battery, spec.weapons, spec.systems])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildGeometry(spec), [key])
}

export interface DroneModelProps {
  spec: DroneSpec
  geometry?: DroneGeometry
  /** Rotor speed in rev/s for animation; 0 = stopped. */
  spin?: number
  thermal?: boolean
  castShadow?: boolean
  /** Keep the model in Z-up (for scenes that already use Z-up). */
  zUp?: boolean
  /** Hide without unmounting (keeps materials and their compiled shaders alive). */
  visible?: boolean
}

export function DroneModel({ spec, geometry, spin = 0, thermal = false, castShadow = true, zUp = false, visible = true }: DroneModelProps) {
  const own = useDroneGeometry(spec)
  const g = geometry ?? own
  const stealth = spec.systems.some(s => s.id === 'stealth')
  const size = Math.max(g.size.x, g.size.y)
  // One material set per model (and view mode), re-coloured in place: new materials would mean new
  // shader compiles, which stall the page every time a slider moves or the hub cycles drones.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mats = useMemo(() => droneMaterials(spec.livery, size, { stealth, thermal }), [thermal])
  useMemo(() => updateDroneMaterials(mats, spec.livery, size, { stealth, thermal }),
    [mats, spec.livery.primary, spec.livery.secondary, spec.livery.accent, spec.livery.finish, spec.livery.pattern, size, stealth, thermal])
  useWarmShaders(mats, castShadow)
  const merged = useMemo(() => mergeByMaterial(g), [g])
  useEffect(() => () => { merged.forEach(m => m.dispose()) }, [merged])
  useEffect(() => () => { Object.values(mats).forEach(m => m.dispose()) }, [mats])

  const rotorRefs = useRef<(THREE.Group | null)[]>([])
  const discRefs = useRef<(THREE.Mesh | null)[]>([])
  useFrame((_, dt) => {
    const w = spin * Math.PI * 2 * Math.min(dt, 0.05)
    g.rotors.forEach((r, i) => {
      const grp = rotorRefs.current[i]
      if (grp) grp.rotation.z += w * r.dir * (r.role === 'tail' ? 4 : 1)
      const disc = discRefs.current[i]
      if (disc) {
        const fast = spin > 8
        ;(disc.material as THREE.MeshBasicMaterial).opacity = fast ? Math.min(0.32, 0.06 + spin / 300) : 0
        disc.visible = fast
      }
    })
  })

  const z = new THREE.Vector3(0, 0, 1)
  return (
    <group rotation={zUp ? [0, 0, 0] : Z_UP_TO_Y_UP} visible={visible}>
      {[...merged.entries()].map(([k, geo]) => (
        <mesh key={k} geometry={geo} material={mats[k as MatKey]} castShadow={castShadow && k !== 'glass'} receiveShadow />
      ))}
      {g.rotors.map((r, i) => {
        const q = new THREE.Quaternion().setFromUnitVectors(z, r.axis)
        return (
          <group key={r.tag + i} position={r.center} quaternion={q}>
            <group ref={el => { rotorRefs.current[i] = el }}>
              <mesh geometry={r.blades} material={mats.prop} castShadow={castShadow} />
              <mesh geometry={r.hub} material={mats.motor} />
            </group>
            <mesh ref={el => { discRefs.current[i] = el }} rotation={[0, 0, 0]} visible={false}>
              <circleGeometry args={[r.radius, 40]} />
              <meshBasicMaterial color="#c8d2dc" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/**
 * Compile every material of the set in the background as soon as the scene is lit, so a part that
 * appears later (a weapon, a lamp, a canopy) doesn't stall the animation while its shader compiles.
 * Uses three's compileAsync where the browser can compile in parallel, otherwise compiles up front.
 */
function useWarmShaders(mats: Record<MatKey, THREE.Material>, castShadow: boolean) {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      const geo = new THREE.PlaneGeometry(1e-4, 1e-4)
      const warm = new THREE.Group()
      for (const m of new Set(Object.values(mats))) {
        const mesh = new THREE.Mesh(geo, m)
        mesh.castShadow = castShadow; mesh.receiveShadow = true
        warm.add(mesh)
      }
      // Without parallel compile support, compile now (during page load) rather than mid-animation.
      if (gl.extensions.has('KHR_parallel_shader_compile')) gl.compileAsync(warm, camera, scene).catch(() => {}).finally(() => geo.dispose())
      else { try { gl.compile(warm, camera, scene) } catch { /* best effort */ } geo.dispose() }
    }, 400) // after <Environment> has set the scene's lighting, so the variants match
    return () => { cancelled = true; clearTimeout(t) }
  }, [mats, castShadow, gl, scene, camera])
}
