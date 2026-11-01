/**
 * The drones you can fly.
 *
 *  - Bundled: every `*.drone.json` in src/drones/ is picked up at build time. Add a file, get a drone.
 *  - Yours: drones added in the browser (button or drag-and-drop) are kept in localStorage.
 */
import { create } from 'zustand'
import type { DroneSpec } from '../engine/types'
import { loadDrone, slug } from './spec'
import { readJSON, uid, writeJSON } from './storage'
import { STORAGE_PREFIX } from '../config'

export interface LibraryDrone {
  id: string
  spec: DroneSpec
  source: 'bundled' | 'mine'
  /** Non-fatal notes from loading, e.g. "not flight-ready". */
  warnings: string[]
}

const files = import.meta.glob('../drones/*.drone.json', { eager: true, import: 'default' }) as Record<string, unknown>

export function loadBundled(entries: Record<string, unknown> = files): LibraryDrone[] {
  const out: LibraryDrone[] = []
  for (const [path, json] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.split('/').pop()!.replace(/\.drone\.json$/, '')
    try {
      const { spec, warnings } = loadDrone(json)
      out.push({ id: `bundled-${slug(file)}`, spec, source: 'bundled', warnings })
    } catch (e) {
      // A broken file in src/drones/ must not take the whole app down.
      console.warn(`Skipped src/drones/${file}.drone.json: ${(e as Error).message}`)
    }
  }
  return out
}

const KEY = `${STORAGE_PREFIX}drones`
interface Stored { id: string; spec: DroneSpec }

function readMine(): LibraryDrone[] {
  const out: LibraryDrone[] = []
  for (const s of readJSON<Stored[]>(KEY, [])) {
    try { out.push({ id: s.id, spec: loadDrone(s.spec).spec, source: 'mine', warnings: [] }) } catch { /* skip an unreadable entry */ }
  }
  return out
}

const bundled = loadBundled()

interface LibraryState {
  bundled: LibraryDrone[]
  mine: LibraryDrone[]
  all: () => LibraryDrone[]
  find: (id: string) => LibraryDrone | undefined
  /** Parses JSON text and adds the drone. Throws SpecError with a readable message. */
  addFromText: (text: string) => LibraryDrone
  remove: (id: string) => void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  bundled,
  mine: readMine(),
  all: () => [...get().mine, ...get().bundled],
  find: id => get().all().find(d => d.id === id),
  addFromText: text => {
    const { spec, warnings } = loadDrone(text)
    const d: LibraryDrone = { id: uid('mine-'), spec, source: 'mine', warnings }
    const mine = [d, ...get().mine]
    writeJSON(KEY, mine.map(m => ({ id: m.id, spec: m.spec })))
    set({ mine })
    return d
  },
  remove: id => {
    const mine = get().mine.filter(m => m.id !== id)
    writeJSON(KEY, mine.map(m => ({ id: m.id, spec: m.spec })))
    set({ mine })
  },
}))
