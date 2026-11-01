/** Environments, missions and the daily challenge. Pure data, shared by the hub, setup and flight. */
import type { DroneSpec } from '../engine/types'

/** Today's date in UTC, e.g. 2026-11-01. The daily challenge is derived from it. */
export const today = () => new Date().toISOString().slice(0, 10)

export type EnvId = 'range' | 'city' | 'forest' | 'harbor' | 'night'
export type MissionId = 'free' | 'rings' | 'targets' | 'intercept' | 'delivery' | 'recon' | 'survival'

export interface EnvDef { id: EnvId; name: string; blurb: string; sky: [string, string]; ground: string; night?: boolean; wind: number; fog: number }
export interface MissionDef { id: MissionId; name: string; blurb: string; timeLimit: number; needs?: (s: DroneSpec) => string | null; stars: [number, number, number]; glyph: string }

export const ENVIRONMENTS: EnvDef[] = [
  { id: 'range', name: 'Proving Ground', blurb: 'Open desert test range. Long sightlines, steady breeze.', sky: ['#7fb2e6', '#f3d9b1'], ground: '#c9a978', wind: 3, fog: 0.0018 },
  { id: 'city', name: 'Urban Block', blurb: 'Streets, towers and gusts that funnel between them.', sky: ['#8fb6d9', '#e6eef5'], ground: '#5d646b', wind: 5, fog: 0.0025 },
  { id: 'forest', name: 'Pine Valley', blurb: 'Rolling hills and tall pines. Fly low if you dare.', sky: ['#9cc4e4', '#e2efe0'], ground: '#5e7a49', wind: 2, fog: 0.004 },
  { id: 'harbor', name: 'Harbor Deck', blurb: 'Container stacks, a cargo ship and open water.', sky: ['#88b4d8', '#f0e6d6'], ground: '#3b6f8f', wind: 7, fog: 0.0022 },
  { id: 'night', name: 'Night Ops', blurb: 'The city after dark. Lights, thermals and long shadows.', sky: ['#05070d', '#141c2e'], ground: '#1a1e24', night: true, wind: 4, fog: 0.006 },
]

const hasWeapon = (s: DroneSpec) => (s.weapons.length ? null : 'Needs a weapon')
const DAMAGING = ['kinetic', 'bomb', 'missile', 'laser']
const hasDamage = (s: DroneSpec) => (s.weapons.some(w => DAMAGING.includes(w.id)) ? null : 'Needs a turret, bombs, missiles or a laser')

export const MISSIONS: MissionDef[] = [
  { id: 'free', name: 'Free Flight', blurb: 'No clock, no score. Learn how your drone really flies.', timeLimit: 0, stars: [0, 0, 0], glyph: '∞' },
  { id: 'rings', name: 'Ring Run', blurb: 'Thread twelve gates as fast as you can. Speed and agility.', timeLimit: 180, stars: [1500, 2500, 3000], glyph: '◎' },
  { id: 'targets', name: 'Target Range', blurb: 'Neutralise the targets before the clock runs out. Accuracy matters.', timeLimit: 120, needs: hasDamage, stars: [1200, 2400, 3600], glyph: '⊕' },
  { id: 'intercept', name: 'Intercept', blurb: 'Rogue drones in the airspace. Net them for double points.', timeLimit: 150, needs: hasWeapon, stars: [1000, 2200, 3400], glyph: '⌗' },
  { id: 'delivery', name: 'Delivery', blurb: 'Hook crates and set them down on the pads. Heavier lifters win.', timeLimit: 200, stars: [1200, 2400, 3500], glyph: '⚓' },
  { id: 'recon', name: 'Recon Sweep', blurb: 'Hold over each zone to scan it. LiDAR and thermal scan faster.', timeLimit: 180, stars: [1200, 2300, 3300], glyph: '✺' },
  { id: 'survival', name: 'Survival', blurb: 'Hostile drones in waves. Last as long as you can.', timeLimit: 0, needs: hasWeapon, stars: [1500, 3500, 6000], glyph: '☠' },
]

export const envById = (id: string) => ENVIRONMENTS.find(e => e.id === id) ?? ENVIRONMENTS[0]
export const missionById = (id: string) => MISSIONS.find(m => m.id === id) ?? MISSIONS[0]

export interface Twist { id: string; label: string; wind?: number; night?: boolean; fog?: number; battery?: number }
const TWISTS: Twist[] = [
  { id: 'gale', label: 'Gale: 12 m/s gusting wind', wind: 12 },
  { id: 'fog', label: 'Fog bank: 90 m visibility', fog: 0.02 },
  { id: 'low', label: 'Half battery', battery: 0.5 },
  { id: 'calm', label: 'Dead calm, perfect air', wind: 0 },
  { id: 'dusk', label: 'Dusk: light failing', night: true },
]

function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

export function dailyChallenge(date = today()) {
  const h = hash(date)
  const missions = MISSIONS.filter(m => m.id !== 'free' && m.id !== 'survival')
  const mission = missions[h % missions.length]
  const env = ENVIRONMENTS[(h >>> 8) % ENVIRONMENTS.length]
  const twist = TWISTS[(h >>> 16) % TWISTS.length]
  return { date, mission, env, twist, key: `daily-${date}` }
}

export function missionKey(mission: MissionId, env: EnvId) { return `${mission}@${env}` }
