// A-6.1 (PRD G-1, G-5, D-7): the collision registry on disk.
// This session writes only its own file; it reads everyone's and merges them.
// A file not touched within STALE_MS (by mtime) is skipped without being read,
// so the cost of a check grows with live sessions, not with every session ever.
import type { EngineInterface, Timer } from 'claude-code'

import { STALE_MS, beat, liveOthers, newEntry, parseEntry, recordEdit, serialize } from './core/registry'
import type { Entry, SessionStatus } from './core/registry'

let dir: string | null | undefined
/** ~/.claude/steward/registry, or null when HOME is unknown (the guard then stays off). */
export async function registryDir($: EngineInterface): Promise<string | null> {
  if (dir !== undefined) return dir
  let home: string | undefined
  try { home = await $.env.get('HOME') } catch { home = undefined }
  dir = home ? `${home.replace(/\/+$/, '')}/.claude/steward/registry` : null
  return dir
}

// This session's own entry. A hot reload starts the module over, so it is read
// back from disk the first time it is needed.
let self: Entry | null = null

async function loadSelf($: EngineInterface): Promise<{ entry: Entry; path: string } | null> {
  const d = await registryDir($)
  if (!d) return null
  const id = await $.session.id()
  const path = `${d}/${id}.json`
  if (!self || self.sessionId !== id) {
    let onDisk: Entry | null = null
    try { if (await $.fs.exists(path)) onDisk = parseEntry(await $.fs.read(path)) } catch { onDisk = null }
    self = onDisk ?? newEntry(id, await $.session.root(), await $.session.cwd(), await $.clock.now())
  }
  return { entry: self, path }
}

async function writeSelf($: EngineInterface, change: (e: Entry, now: number) => Entry): Promise<Entry | null> {
  const s = await loadSelf($)
  if (!s) return null
  const next = change(s.entry, await $.clock.now())
  self = next
  await $.fs.write(s.path, serialize(next))
  return next
}

/** G-1: after a successful Edit, Write or NotebookEdit (absolute, normalised path). */
export async function noteEdit($: EngineInterface, file: string, windowMs: number): Promise<void> {
  await writeSelf($, (e, now) => recordEdit(e, file, now, windowMs))
}

/** G-5: heartbeat, optionally with a new status or task. */
export async function heartbeat($: EngineInterface, patch: { status?: SessionStatus; task?: string } = {}): Promise<void> {
  await writeSelf($, (e, now) => beat(e, now, patch))
}

/** D-7: every other live session, merged from their files. Never throws; a bad file is skipped. */
export async function readOthers($: EngineInterface): Promise<Entry[]> {
  const d = await registryDir($)
  if (!d) return []
  const id = await $.session.id()
  const now = await $.clock.now()
  let names
  try { names = await $.fs.list(d) } catch { return [] }
  const fresh = names.filter(n => n.kind === 'file' && n.name.endsWith('.json') && n.name !== `${id}.json` && now - n.mtimeMs <= STALE_MS + 5_000)
  const entries: (Entry | null)[] = []
  for (const n of fresh) {
    try { entries.push(parseEntry(await $.fs.read(`${d}/${n.name}`))) } catch { /* half-written or gone: skip */ }
  }
  return liveOthers(entries, id, now)
}

// ── A-6.5 (PRD G-5): the heartbeat ──
export const HEARTBEAT_MS = 30_000
let hb: Timer | null = null

/** session.start (and each reload): beat now, then every 30 s. A reload replaces the old timer. */
export async function startHeartbeat($: EngineInterface): Promise<void> {
  hb?.cancel()
  await heartbeat($)
  hb = $.clock.every(HEARTBEAT_MS, () => { void heartbeat($).catch(() => undefined) })
}

/** session.end: say so at once (others stop asking about this session), and stop beating. */
export async function endHeartbeat($: EngineInterface): Promise<void> {
  hb?.cancel()
  hb = null
  await heartbeat($, { status: 'ended' })
}
