// All of Steward's session state, and the ONLY file that reads or writes it
// (the engine's scan requires state refs to live in the file that uses them).
// Event hooks call the setters; render hooks call readAll() (which subscribes them).
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Briefs, CacheView, Demo, GuardEvent, HandoffView, Live, OtherSession, AutoState, Boundary, OffMark, SectionId, ZoneMark } from '../types'
import { asSetting, resolveAuto } from './core/auto'
import type { TaskStatus } from './core/boundary'
import type { AutoSetting } from './core/auto'

export const EMPTY_LIVE: Live = {
  tokens: null, window: null, percent: null, autoCompactAt: null,
  fiveHour: null, fiveHourResets: null, week: null, weekResets: null, usd: null,
}

const live = atom({ plugin: 'steward', key: 'live' } as const, EMPTY_LIVE, { shape: 'live-1' })
const cache = atom({ plugin: 'steward', key: 'cache' } as const, { minutesLeft: null, secondsLeft: null, isCold: false, ttlMinutes: 60, lastAt: null, hit: null } as CacheView, { shape: 'cache-2' })
const handoff = atom({ plugin: 'steward', key: 'handoff' } as const, { phase: 'idle' } as HandoffView, { shape: 'handoff-1' })
const others = atom({ plugin: 'steward', key: 'others' } as const, [] as OtherSession[], { shape: 'others-1' })
const guards = atom({ plugin: 'steward', key: 'guards' } as const, [] as GuardEvent[], { shape: 'guards-1' })
const demo = atom({ plugin: 'steward', key: 'demo' } as const, 'off' as Demo)
/** True only while the pane is placed AND the tab in front (A-2.9). */
const paneUp = atom({ plugin: 'steward', key: 'paneUp' } as const, false)
/** True while the pane is open but another tab (e.g. Files) is in front of it. */
const paneBehind = atom({ plugin: 'steward', key: 'paneBehind' } as const, false)
/** Last real (non-demo) zone, so a toast fires only when it changes. 'none' = no reading yet. */
const lastZone = atom({ plugin: 'steward', key: 'lastZone' } as const, 'none' as ZoneMark)
/** Bumped once a minute while the pane is up, so time-based text (reset countdowns) redraws. */
const tick = atom({ plugin: 'steward', key: 'tick' } as const, 0)
/** Main-session turns completed so far (subagent turns not counted). */
/** The main loop's model as /model shows it (A-4.4 pricing). */
const model = atom({ plugin: 'steward', key: 'model' } as const, null as string | null)
const turns = atom({ plugin: 'steward', key: 'turns' } as const, 0)
/** Calibration marks (A-2.8); the full log lives in $.store under MARKS_KEY. */
const marks = atom({ plugin: 'steward', key: 'marks' } as const, [] as OffMark[], { shape: 'marks-1' })
/** Effective auto-handoff setting, loaded from $.store (A-2.3). */
const auto = atom({ plugin: 'steward', key: 'auto' } as const, { on: false, atTokens: null, source: 'default' } as AutoState, { shape: 'auto-1' })
/** Auto-handoff was cancelled this session: don't re-arm until the setting changes (A-2.4). */
const snoozed = atom({ plugin: 'steward', key: 'snoozed' } as const, false)
/** Claude's task list as Steward has seen it (A-2.6): id → status. */
const tasks = atom({ plugin: 'steward', key: 'tasks' } as const, {} as Record<string, TaskStatus>, { shape: 'tasks-1' })
/** The boundary suggestion on show in the pane, or null. */
const boundary = atom({ plugin: 'steward', key: 'boundary' } as const, null as Boundary | null, { shape: 'boundary-1' })
/** Shown once per session (C-8). */
const boundaryShown = atom({ plugin: 'steward', key: 'boundaryShown' } as const, false)
/** Recent handoff briefs on disk (A-3.6). */
const briefs = atom({ plugin: 'steward', key: 'briefs' } as const, { list: [], week: 0 } as Briefs, { shape: 'briefs-1' })
/** Blast patterns allowed for this session only (A-5.3 "Allow for session"). */
const allowed = atom({ plugin: 'steward', key: 'allowed' } as const, [] as string[], { shape: 'allowed-1' })
/** Mirror of the saved allowlist in $.store, so the pane draws it without I/O (A-5.5). */
const savedAllow = atom({ plugin: 'steward', key: 'savedAllow' } as const, [] as string[], { shape: 'savedAllow-1' })
const collapsed = atom({ plugin: 'steward', key: 'collapsed' } as const, [] as SectionId[], { shape: 'collapsed-1' })

export type State = {
  live: Live
  cache: CacheView
  handoff: HandoffView
  others: OtherSession[]
  guards: GuardEvent[]
  demo: Demo
  paneUp: boolean
  paneBehind: boolean
  collapsed: SectionId[]
  tick: number
  auto: AutoState
  turns: number
  model: string | null
  marks: OffMark[]
  boundary: Boundary | null
  briefs: Briefs
  allowed: string[]
  savedAllow: string[]
}

export async function readAll($: EngineInterface): Promise<State> {
  return {
    live: await read($, live),
    cache: await read($, cache),
    handoff: await read($, handoff),
    others: await read($, others),
    guards: await read($, guards),
    demo: await read($, demo),
    paneUp: await read($, paneUp),
    paneBehind: await read($, paneBehind),
    collapsed: await read($, collapsed),
    tick: await read($, tick),
    auto: await read($, auto),
    turns: await read($, turns),
    model: await read($, model),
    boundary: await read($, boundary),
    marks: await read($, marks),
    briefs: await read($, briefs),
    allowed: await read($, allowed),
    savedAllow: await read($, savedAllow),
  }
}

export async function setLive($: EngineInterface, patch: Partial<Live>): Promise<void> {
  await update($, live, prev => ({ ...prev, ...patch }))
}

export async function setDemo($: EngineInterface, d: Demo): Promise<void> {
  await update($, demo, () => d)
}

export async function setPaneUp($: EngineInterface, isUp: boolean): Promise<void> {
  await update($, paneUp, () => isUp)
  if (!isUp) await update($, paneBehind, () => false)
}

/** Writes pane visibility only when it changed, so the 5 s poll doesn't redraw for nothing. */
export async function setPaneView($: EngineInterface, isUp: boolean, isBehind: boolean): Promise<void> {
  if ((await read($, paneUp)) !== isUp) await update($, paneUp, () => isUp)
  if ((await read($, paneBehind)) !== isBehind) await update($, paneBehind, () => isBehind)
}

/** Restores folded sections from the cross-session store at start. */
export async function restoreCollapsed($: EngineInterface): Promise<void> {
  const saved = await $.store.get('collapsed')
  if (Array.isArray(saved)) await update($, collapsed, () => saved as SectionId[])
}

export async function toggleCollapsed($: EngineInterface, id: SectionId): Promise<void> {
  const next = await update($, collapsed, list => (list.includes(id) ? list.filter(s => s !== id) : [...list, id]))
  await $.store.set('collapsed', next)
}

export async function readLive($: EngineInterface): Promise<Live> {
  return read($, live)
}

/** Stores the new real zone and returns the one before it. */
export async function swapZone($: EngineInterface, z: ZoneMark): Promise<ZoneMark> {
  const prev = await read($, lastZone)
  await update($, lastZone, () => z)
  return prev
}

/** Redraws the pane (it reads `tick`) once a minute; skipped while the pane is closed. */
export async function bumpTick($: EngineInterface): Promise<void> {
  if (!(await read($, paneUp))) return
  await update($, tick, n => n + 1)
}

export async function countTurn($: EngineInterface): Promise<number> {
  return update($, turns, n => n + 1)
}

export async function readTurns($: EngineInterface): Promise<number> {
  return read($, turns)
}

const MARKS_KEY = 'marks'
const MARKS_CAP = 500

/** Loads the cross-session calibration log at start. */
export async function restoreMarks($: EngineInterface): Promise<void> {
  const saved = await $.store.get(MARKS_KEY)
  if (Array.isArray(saved)) await update($, marks, () => saved as OffMark[])
}

/** Appends one mark to the log (oldest dropped past MARKS_CAP) and returns the count. */
export async function addMark($: EngineInterface, m: OffMark): Promise<number> {
  const saved = await $.store.get(MARKS_KEY)
  const next = [...(Array.isArray(saved) ? (saved as OffMark[]) : []), m].slice(-MARKS_CAP)
  await $.store.set(MARKS_KEY, next)
  await update($, marks, () => next)
  return next.length
}

// ── auto-handoff setting (A-2.3): user key 'auto', project key 'auto@<root>' ──
async function projectKey($: EngineInterface): Promise<string> {
  return `auto@${await $.session.root()}`
}

/** Re-reads both scopes from the store and publishes the effective setting. */
export async function loadAuto($: EngineInterface): Promise<AutoState> {
  const user = asSetting(await $.store.get('auto'))
  const project = asSetting(await $.store.get(await projectKey($)))
  const view = resolveAuto(user, project)
  await update($, auto, () => view)
  return view
}

export async function saveAuto($: EngineInterface, scope: 'user' | 'project', value: AutoSetting | null): Promise<AutoState> {
  const key = scope === 'user' ? 'auto' : await projectKey($)
  if (value === null) await $.store.delete(key)
  else await $.store.set(key, value)
  await update($, snoozed, () => false)
  return loadAuto($)
}

export async function readAuto($: EngineInterface): Promise<AutoState> {
  return read($, auto)
}

// ── auto-handoff countdown (A-2.4) ──
export async function readHandoff($: EngineInterface): Promise<HandoffView> {
  return read($, handoff)
}

export async function setHandoff($: EngineInterface, h: HandoffView): Promise<void> {
  await update($, handoff, () => h)
}

export async function readSnoozed($: EngineInterface): Promise<boolean> {
  return read($, snoozed)
}

export async function setSnoozed($: EngineInterface, isSnoozed: boolean): Promise<void> {
  await update($, snoozed, () => isSnoozed)
}

// ── task boundary (A-2.6) ──
/** Applies task-list changes; returns the whole map after them. */
export async function patchTasks($: EngineInterface, patch: Record<string, TaskStatus | null>, replace = false): Promise<Record<string, TaskStatus>> {
  return update($, tasks, prev => {
    const next: Record<string, TaskStatus> = replace ? {} : { ...prev }
    for (const [id, st] of Object.entries(patch)) {
      if (st === null) delete next[id]
      else next[id] = st
    }
    return next
  })
}

export async function readBoundaryShown($: EngineInterface): Promise<boolean> {
  return read($, boundaryShown)
}

export async function showBoundary($: EngineInterface, b: Boundary | null): Promise<void> {
  await update($, boundary, () => b)
  if (b) await update($, boundaryShown, () => true)
}

// ── A-3.1 last brief (across sessions: the re-seed after /clear reads it in A-3.3) ──
export type SavedBrief = { text: string; at: number; file: string | null }
export async function saveLastBrief($: EngineInterface, b: SavedBrief): Promise<void> {
  await $.store.set('lastBrief', b)
}

// ── A-3.3 handoff across /clear: $.store survives the session change ──
export type PendingBrief = { brief: string; at: number; rel: string }
export async function readPending($: EngineInterface): Promise<PendingBrief | undefined> {
  return (await $.store.get('pendingBrief')) as PendingBrief | undefined
}
export async function savePending($: EngineInterface, p: PendingBrief): Promise<void> { await $.store.set('pendingBrief', p) }
export async function dropPending($: EngineInterface): Promise<void> { await $.store.delete('pendingBrief') }

// "Edit brief first" (option a): the brief sits in the prompt box until Enter.
export type EditingBrief = { at: number; rel: string }
export async function readEditing($: EngineInterface): Promise<EditingBrief | undefined> {
  return (await $.store.get('editingBrief')) as EditingBrief | undefined
}
export async function saveEditing($: EngineInterface, v: EditingBrief): Promise<void> { await $.store.set('editingBrief', v) }
export async function dropEditing($: EngineInterface): Promise<void> { await $.store.delete('editingBrief') }

export async function setBriefs($: EngineInterface, b: Briefs): Promise<void> {
  await update($, briefs, () => b)
}

// ── A-4.1/4.2 cache countdown ──
export async function readCache($: EngineInterface): Promise<CacheView> {
  return read($, cache)
}
export async function patchCache($: EngineInterface, patch: Partial<CacheView>): Promise<CacheView> {
  return update($, cache, prev => ({ ...prev, ...patch }))
}
export async function loadTtlSetting($: EngineInterface): Promise<number | undefined> {
  const v = await $.store.get('ttlMinutes')
  return typeof v === 'number' ? v : undefined
}
export async function saveTtlSetting($: EngineInterface, minutes: number): Promise<void> {
  await $.store.set('ttlMinutes', minutes)
}

export async function setModel($: EngineInterface, m: string | null): Promise<void> {
  await update($, model, () => m)
}

// ── A-5.3 blast guard ──
export async function readAllowed($: EngineInterface): Promise<string[]> {
  return read($, allowed)
}

export async function allowForSession($: EngineInterface, pattern: string): Promise<void> {
  await update($, allowed, l => (l.includes(pattern) ? l : [...l, pattern]))
}

/** One guard outcome for the pane's Guards section; the last 50 are kept. */
export async function noteGuard($: EngineInterface, g: GuardEvent): Promise<void> {
  await update($, guards, l => [...l, g].slice(-50))
}

// ── A-6.6 other sessions in this project ──
/** Writes only when something changed, so a quiet 30 s refresh redraws nothing. */
export async function setOthers($: EngineInterface, list: OtherSession[]): Promise<void> {
  const cur = await read($, others)
  if (JSON.stringify(cur) !== JSON.stringify(list)) await update($, others, () => list)
}

// ── A-5.4 persistent blast allowlist ($.store, every session and project) ──
export async function loadSavedAllow($: EngineInterface): Promise<string[]> {
  const v = await $.store.get('blastAllow')
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
export async function saveSavedAllow($: EngineInterface, list: string[]): Promise<void> {
  await $.store.set('blastAllow', list)
  await update($, savedAllow, () => list)
}
/** session.start: copy the saved list into the pane's atom (another session may have changed it). */
export async function syncSavedAllow($: EngineInterface): Promise<void> {
  const list = await loadSavedAllow($)
  await update($, savedAllow, () => list)
}
