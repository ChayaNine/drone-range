/**
 * Local scoreboard. Scores live in this browser only (localStorage); there is no server.
 * Keys look like "rings@city" (mission at environment) or "daily-2026-11-01".
 */
import { readJSON, writeJSON } from './storage'
import { STORAGE_PREFIX } from '../config'

export interface RunRecord { score: number; stars: number; timeMs: number; droneName: string; at: string }

const KEY = `${STORAGE_PREFIX}runs`
const KEEP = 8

type Book = Record<string, RunRecord[]>

/** Best runs for one board, highest score first. */
export function topRuns(boardKey: string): RunRecord[] {
  return readJSON<Book>(KEY, {})[boardKey] ?? []
}

export function bestRun(boardKey: string): RunRecord | null {
  return topRuns(boardKey)[0] ?? null
}

/** Stores a run. `newBest` is true when it beats everything on that board. */
export function recordRun(boardKey: string, run: RunRecord): { newBest: boolean; prevBest: number | null; board: RunRecord[] } {
  const book = readJSON<Book>(KEY, {})
  const before = book[boardKey] ?? []
  const prevBest = before[0]?.score ?? null
  const board = [...before, run].sort((a, b) => b.score - a.score).slice(0, KEEP)
  book[boardKey] = board
  writeJSON(KEY, book)
  return { newBest: prevBest === null || run.score > prevBest, prevBest, board }
}
