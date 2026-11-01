/**
 * Materials for a drone, built from its livery. Hull patterns are procedural in MODEL space
 * (the meshes carry no UVs), injected into MeshStandardMaterial so lighting and shadows stay PBR.
 */
import * as THREE from 'three'
import type { Livery, Pattern } from '../../engine/types'
import type { MatKey } from '../../engine/geometry'

const PATTERN_ID: Record<Pattern, number> = { solid: 0, split: 1, stripe: 2, digital: 3, hazard: 4 }

function roughness(finish: Livery['finish']) { return finish === 'matte' ? 0.86 : finish === 'satin' ? 0.52 : 0.22 }

function patterned(livery: Livery, size: number, stealth: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: livery.primary, roughness: stealth ? 0.95 : roughness(livery.finish), metalness: livery.finish === 'gloss' ? 0.2 : 0.06,
  })
  const uniforms = {
    uPattern: { value: stealth ? 0 : PATTERN_ID[livery.pattern] },
    uA: { value: new THREE.Color(stealth ? '#1a1d21' : livery.primary) },
    uB: { value: new THREE.Color(stealth ? '#1a1d21' : livery.secondary) },
    uC: { value: new THREE.Color(livery.accent) },
    uSize: { value: Math.max(size, 0.05) },
  }
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vModelPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvModelPos = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vModelPos;
uniform int uPattern; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uSize;
float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
vec3 base = uA;
vec3 q = vModelPos / uSize;
if (uPattern == 1) { base = q.z > 0.02 ? uA : uB; }
else if (uPattern == 2) { base = abs(q.y) < 0.045 ? uC : uA; if (abs(abs(q.y) - 0.07) < 0.012) base = uB; }
else if (uPattern == 3) {
  float n = h3(floor(q * 14.0)); float n2 = h3(floor(q * 5.0) + 3.1);
  base = n2 > 0.62 ? uB : (n > 0.72 ? mix(uA, uB, 0.55) : uA);
  if (n2 > 0.9) base = mix(uB, vec3(0.0), 0.35);
}
else if (uPattern == 4) { base = fract((q.x + q.y) * 6.0) < 0.5 ? uA : uB; }
vec4 diffuseColor = vec4( base, opacity );`)
  }
  // The pattern is a uniform, so every hull shares one compiled program.
  m.customProgramCacheKey = () => 'range-hull'
  m.userData.uniforms = uniforms
  return m
}

/**
 * Re-colour an existing material set in place. Changing colours, roughness or uniforms never
 * recompiles a shader; building new materials (and disposing the old ones) does, and shader
 * compiles are the main cause of stutter, especially on Windows where WebGL goes through Direct3D.
 */
export function updateDroneMaterials(mats: Record<MatKey, THREE.Material>, livery: Livery, size: number, opts: { stealth?: boolean; thermal?: boolean } = {}) {
  if (opts.thermal) return
  const r = roughness(livery.finish)
  const stealth = !!opts.stealth
  const std = (k: MatKey) => mats[k] as THREE.MeshStandardMaterial
  const hull = std('hull')
  const u = hull.userData.uniforms as { uPattern: { value: number }; uA: { value: THREE.Color }; uB: { value: THREE.Color }; uC: { value: THREE.Color }; uSize: { value: number } } | undefined
  if (u) {
    u.uPattern.value = stealth ? 0 : PATTERN_ID[livery.pattern]
    u.uA.value.set(stealth ? '#1a1d21' : livery.primary)
    u.uB.value.set(stealth ? '#1a1d21' : livery.secondary)
    u.uC.value.set(livery.accent)
    u.uSize.value = Math.max(size, 0.05)
  }
  hull.color.set(livery.primary)
  hull.roughness = stealth ? 0.95 : r
  hull.metalness = livery.finish === 'gloss' ? 0.2 : 0.06
  std('hull2').color.set(stealth ? '#16191c' : livery.secondary); std('hull2').roughness = r
  std('frame').color.set(stealth ? '#15181b' : livery.secondary); std('frame').roughness = Math.max(r, 0.45)
  std('accent').color.set(livery.accent)
  std('weapon').color.set(stealth ? '#1b1e22' : '#3a4249')
}

export function droneMaterials(livery: Livery, size: number, opts: { stealth?: boolean; thermal?: boolean } = {}): Record<MatKey, THREE.Material> {
  const r = roughness(livery.finish)
  const stealth = !!opts.stealth
  const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: r, metalness: 0.1, ...extra })
  if (opts.thermal) {
    const hot = (k: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.08 - k * 0.08, 1, 0.45 + k * 0.4) })
    const warm = hot(0.2), cold = new THREE.MeshBasicMaterial({ color: '#2a1a4a' })
    return {
      hull: warm, hull2: warm, frame: cold, motor: hot(1), bell: hot(1), prop: cold, dark: cold, glass: cold, metal: cold,
      accent: warm, weapon: hot(0.5), sensor: hot(0.4), navRed: hot(0.6), navGreen: hot(0.6), navWhite: hot(0.6), lamp: hot(1), battery: hot(0.7),
    }
  }
  return {
    hull: patterned(livery, size, stealth),
    hull2: std(stealth ? '#16191c' : livery.secondary),
    frame: std(stealth ? '#15181b' : livery.secondary, { roughness: Math.max(r, 0.45) }),
    motor: std('#23282e', { roughness: 0.55, metalness: 0.4 }),
    bell: std('#9aa3ab', { roughness: 0.3, metalness: 0.85 }),
    prop: std('#15191d', { roughness: 0.6 }),
    dark: std('#1f242a', { roughness: 0.7 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#0b1520', roughness: 0.05, metalness: 0.2, clearcoat: 1, transmission: 0, reflectivity: 0.9 }),
    metal: std('#a8b0b8', { roughness: 0.28, metalness: 0.9 }),
    accent: std(livery.accent, { roughness: 0.4 }),
    weapon: std(stealth ? '#1b1e22' : '#3a4249', { roughness: 0.55, metalness: 0.35 }),
    sensor: std('#2a3138', { roughness: 0.4, metalness: 0.3 }),
    navRed: new THREE.MeshStandardMaterial({ color: '#ff3b3b', emissive: '#ff2020', emissiveIntensity: 2.4 }),
    navGreen: new THREE.MeshStandardMaterial({ color: '#33e07a', emissive: '#20ff70', emissiveIntensity: 2.4 }),
    navWhite: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 2 }),
    lamp: new THREE.MeshStandardMaterial({ color: '#fff5d0', emissive: '#fff0c0', emissiveIntensity: 1.6 }),
    battery: std('#2b3138', { roughness: 0.6 }),
  }
}
