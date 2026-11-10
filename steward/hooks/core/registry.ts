// Pure: A-6.1 (PRD G-1, G-5, D-7) the collision registry.
// One JSON file per session under ~/.claude/steward/registry/<sessionId>.json,
// written only by that session (no locking needed), merged on read. A session
// whose heartbeat is older than STALE_MS, or that said it ended, is not live.

export const REGISTRY_VERSION = 1
export const STALE_MS = 2 * 60_000
export const DEFAULT_WINDOW_MIN = 30
/** Edits kept per session file: enough for a long session, small to read. */
export const MAX_EDITS = 200

export type SessionStatus = 'working' | 'idle' | 'ended'

export type Edit = { file: string; at: number }

export type Entry = {
  v: number
  sessionId: string
  /** The project root ($.session.root): sessions "here" share it. */
  root: string
  cwd: string
  /** Last prompt, trimmed (G-5). */
  task: string
  status: SessionStatus
  heartbeatAt: number
  /** Newest last; one per file. */
  edits: Edit[]
}

export function newEntry(sessionId: string, root: string, cwd: string, now: number): Entry {
  return { v: REGISTRY_VERSION, sessionId, root, cwd, task: '', status: 'idle', heartbeatAt: now, edits: [] }
}

const str = (x: unknown): x is string => typeof x === 'string'
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** A file's text → an Entry, or null for anything malformed or half-written. */
export function parseEntry(text: string): Entry | null {
  let o: unknown
  try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (r['v'] !== REGISTRY_VERSION || !str(r['sessionId']) || !r['sessionId'] || !str(r['root']) || !num(r['heartbeatAt'])) return null
  const status = r['status'] === 'working' || r['status'] === 'idle' || r['status'] === 'ended' ? r['status'] : 'idle'
  const edits = Array.isArray(r['edits'])
    ? r['edits'].filter((e): e is Edit => !!e && typeof e === 'object' && str((e as Edit).file) && num((e as Edit).at))
        .map(e => ({ file: e.file, at: e.at }))
    : []
  return {
    v: REGISTRY_VERSION, sessionId: r['sessionId'], root: r['root'], cwd: str(r['cwd']) ? r['cwd'] : r['root'],
    task: str(r['task']) ? r['task'] : '', status, heartbeatAt: r['heartbeatAt'], edits,
  }
}

export const serialize = (e: Entry): string => JSON.stringify(e)

/** Absolute, without `.`/`..` segments or a trailing slash, so two sessions name a file alike. */
export function normPath(cwd: string, p: string): string {
  const abs = p.startsWith('/') ? p : `${cwd.replace(/\/+$/, '')}/${p}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/** G-1: note one successful edit; the file moves to newest, edits past the window drop. */
export function recordEdit(e: Entry, file: string, now: number, windowMs: number): Entry {
  const edits = [...e.edits.filter(x => x.file !== file && now - x.at <= windowMs), { file, at: now }].slice(-MAX_EDITS)
  return { ...e, edits, heartbeatAt: now }
}

/** "fix the pricing page so…" → one line of at most `max` characters. */
export function trimTask(prompt: string, max = 80): string {
  const one = prompt.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** G-5: the heartbeat, with what the session is doing now. */
export function beat(e: Entry, now: number, patch: { status?: SessionStatus; task?: string } = {}): Entry {
  return { ...e, heartbeatAt: now, ...(patch.status ? { status: patch.status } : {}), ...(patch.task !== undefined ? { task: trimTask(patch.task) } : {}) }
}

export const isLive = (e: Entry, now: number): boolean => e.status !== 'ended' && now - e.heartbeatAt <= STALE_MS

/** D-7 merged read: every OTHER live session (newest heartbeat first). */
export function liveOthers(entries: readonly (Entry | null)[], selfId: string, now: number): Entry[] {
  const best = new Map<string, Entry>()
  for (const e of entries) {
    if (!e || e.sessionId === selfId || !isLive(e, now)) continue
    const prev = best.get(e.sessionId)
    if (!prev || e.heartbeatAt > prev.heartbeatAt) best.set(e.sessionId, e)
  }
  return [...best.values()].sort((a, b) => b.heartbeatAt - a.heartbeatAt)
}

export type Touch = { sessionId: string; task: string; status: SessionStatus; at: number }

/** G-2: which other live sessions edited this file within the window (most recent first). */
export function touchedBy(others: readonly Entry[], file: string, now: number, windowMs: number): Touch[] {
  const out: Touch[] = []
  for (const o of others) {
    const hit = o.edits.find(x => x.file === file && now - x.at <= windowMs)
    if (hit) out.push({ sessionId: o.sessionId, task: o.task, status: o.status, at: hit.at })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** G-6: other live sessions in the same project root. */
export const sameRoot = (others: readonly Entry[], root: string): Entry[] => others.filter(o => o.root === root)
