/**
 * localStorage that never throws. It can be missing, full or blocked (private windows, sandboxed
 * iframes); every call then degrades to an in-memory map for the life of the tab.
 */

const memory = new Map<string, string>()

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw != null) return JSON.parse(raw) as T
  } catch { /* fall through */ }
  const m = memory.get(key)
  if (m != null) { try { return JSON.parse(m) as T } catch { /* ignore */ } }
  return fallback
}

export function writeJSON(key: string, value: unknown) {
  const raw = JSON.stringify(value)
  memory.set(key, raw)
  try { localStorage.setItem(key, raw) } catch { /* quota or blocked: the in-memory copy is kept */ }
}

export function readString(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return memory.get(key) ?? null }
}

export function writeString(key: string, value: string) {
  memory.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

export function removeKey(key: string) {
  memory.delete(key)
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

export function uid(prefix = ''): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return prefix + r
}
