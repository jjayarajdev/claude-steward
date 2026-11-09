// Every action is reachable three ways: band button, pane button, /steward subcommand.
// Phase 1 wires the routing; the real behaviour lands in the phase named below.
import type { EngineInterface, Timer } from 'claude-code'

import type { ActionId } from './core/band'
import { addMark, patchTasks, readBoundaryShown, showBoundary, loadAuto, readAuto, readHandoff, readSnoozed, saveAuto, setHandoff, setSnoozed, readLive, readTurns, setPaneUp, setPaneView, toggleCollapsed } from './state'
import { shortTokens, zoneOf } from './core/zones'
import { allDone, isGitCommit, shouldSuggest } from './core/boundary'
import type { TaskStatus } from './core/boundary'
import { COUNTDOWN_SECONDS, parseAuto, shouldArm } from './core/auto'
import { startFresh, startHandoff } from './handoff'
import { keepWarm } from './cache'
import type { AutoState } from '../types'
import type { ZoneConfig } from './core/zones'
import type { SectionId } from '../types'

export const PANE_ID = 'steward'


export async function openPane($: EngineInterface, asked: boolean): Promise<string> {
  // A-0.7: nothing to draw on (a -p run): don't try.
  if ((await $.session.surfaces()).length === 0) return 'no surface to draw the pane on'
  // `focus` raises the pane over another tab (A-2.9). Only when the person asked:
  // the engine grants it from an empty prompt, and the pane then holds the keys (Esc returns them).
  const r = await $.ui.open(asked ? { id: PANE_ID, title: 'Steward', focus: true } : { id: PANE_ID, title: 'Steward' })
  await setPaneUp($, r.isPlaced)
  await syncPane($)
  if (r.isPlaced) return 'Steward pane opened.'
  return asked ? `Steward pane not placed: ${r.reason}` : 'Steward pane waits for a wider terminal (run /steward to open it now).'
}

export async function closePane($: EngineInterface): Promise<string> {
  await $.ui.close({ id: PANE_ID })
  await setPaneUp($, false)
  return 'Steward pane closed. The line above the prompt takes over.'
}

/** A-2.9: "up" means placed and in front. Behind another tab counts as not showing. */
export async function syncPane($: EngineInterface): Promise<void> {
  const p = (await $.ui.panes()).find(x => x.id === PANE_ID)
  const isPlaced = !!p && p.isPlaced
  await setPaneView($, isPlaced && !!p?.isShown, isPlaced && !p?.isShown)
}

export async function togglePane($: EngineInterface): Promise<string> {
  const p = (await $.ui.panes()).find(x => x.id === PANE_ID)
  // Behind another tab: bring it forward instead of closing it.
  return p && p.isPlaced && p.isShown ? closePane($) : openPane($, true)
}

export async function runAction($: EngineInterface, id: ActionId): Promise<string> {
  if (id === 'pane') return togglePane($)
  if (id === 'details') return openPane($, true)
  if (id === 'auto') return toggleAuto($)
  if (id === 'cancel') return cancelCountdown($, 'cancelled')
  if (id === 'handoff') return startHandoff($)
  if (id === 'fresh') return startFresh($)
  return keepWarm($) // 'warm'
}

/** COMMANDS section: put a command in the prompt for the person to finish or send. */
export async function fillCommand($: EngineInterface, text: string): Promise<void> {
  await $.prompt.fill({ text })
}

export async function toggleSection($: EngineInterface, id: SectionId): Promise<void> {
  await toggleCollapsed($, id)
}

/** A-2.8 "Claude seems off": log where in the context it happened, for re-tuning the zones (A-7.6). */
export async function markOff($: EngineInterface, zones: ZoneConfig): Promise<string> {
  const l = await readLive($)
  const pct = l.window && l.tokens !== null ? Math.round((l.tokens / l.window) * 100) : (l.percent ?? 0)
  const zone = zoneOf(l.tokens, l.window, l.autoCompactAt, zones).zone
  const turn = await readTurns($)
  const count = await addMark($, { tokens: l.tokens, window: l.window, pct, zone, turn, at: await $.clock.now() })
  const msg = `Steward: marked "seems off" at ${shortTokens(l.tokens)} (${pct}%, ${zone}, turn ${turn}). ${count} mark${count === 1 ? '' : 's'} logged.`
  $.ui.toast(msg)
  return msg
}

const SOURCE = { project: 'this project', user: 'your default', default: 'built-in default' } as const

export function describeAuto(v: AutoState): string {
  const at = v.atTokens ? `at ${shortTokens(v.atTokens)} tokens` : 'at the red zone'
  return `Auto-handoff ${v.on ? `ON, ${at}` : 'OFF'} (${SOURCE[v.source]}).`
}

/** `/steward auto …` (A-2.3). The countdown that uses it arrives with A-2.4. */
export async function autoCommand($: EngineInterface, args: string): Promise<string> {
  const c = parseAuto(args)
  if (c.kind === 'error') return c.message
  if (c.kind === 'show') return `${describeAuto(await loadAuto($))}
/steward auto on|off|<tokens>  ·  /steward auto here on|off|<tokens>|reset`
  const v = c.kind === 'reset' ? await saveAuto($, 'project', null) : await saveAuto($, c.scope, c.value)
  const msg = `Steward: ${describeAuto(v)}`
  $.ui.toast(msg)
  return msg
}

/** Pane/band `a`: flips on/off at whichever scope currently decides, keeping its threshold. */
export async function toggleAuto($: EngineInterface): Promise<string> {
  const v = await readAuto($)
  const scope = v.source === 'project' ? 'project' : 'user'
  const next = await saveAuto($, scope, { on: !v.on, atTokens: v.atTokens })
  const msg = `Steward: ${describeAuto(next)}`
  $.ui.toast(msg)
  return msg
}

// ── A-2.4 auto-handoff countdown ──
let countdown: Timer | null = null

/** Called after a main-session turn ends. Arms the countdown when shouldArm() says so. */
export async function maybeArm($: EngineInterface, zones: ZoneConfig, isMain: boolean, isAnswer: boolean): Promise<void> {
  const l = await readLive($)
  const h = await readHandoff($)
  const ok = shouldArm({
    auto: await readAuto($), tokens: l.tokens, redAt: zoneOf(l.tokens, l.window, l.autoCompactAt, zones).redAt,
    isMain, isAnswer, isBusy: h.phase !== 'idle', isSnoozed: await readSnoozed($),
  })
  if (ok) await startCountdown($)
}

export async function startCountdown($: EngineInterface): Promise<void> {
  countdown?.cancel()
  await setHandoff($, { phase: 'countdown', secondsLeft: COUNTDOWN_SECONDS })
  const text = `Auto-handoff in ${COUNTDOWN_SECONDS}s. Cancel: 1 in the band, c in the pane, /steward cancel, or start typing.`
  const sent = await $.ui.notify(text, { title: 'Steward' })
  if (!sent.isSent) $.ui.toast(`Steward: ${text}`)
  countdown = $.clock.every(1000, () => { void tickCountdown($) })
}

async function tickCountdown($: EngineInterface): Promise<void> {
  const h = await readHandoff($)
  if (h.phase !== 'countdown') { countdown?.cancel(); countdown = null; return }
  if (h.secondsLeft > 1) { await setHandoff($, { phase: 'countdown', secondsLeft: h.secondsLeft - 1 }); return }
  countdown?.cancel(); countdown = null
  await setHandoff($, { phase: 'idle' })
  await setSnoozed($, true) // fired once; until Phase 3 clears the session, don't loop
  await startHandoff($, true)
}

/** Esc isn't delivered to mods, so: band 1, pane c, /steward cancel, typing, or a new turn. */
export async function cancelCountdown($: EngineInterface, why: string): Promise<string> {
  const h = await readHandoff($)
  if (h.phase !== 'countdown') return 'No auto-handoff countdown to cancel.'
  countdown?.cancel(); countdown = null
  await setHandoff($, { phase: 'idle' })
  await setSnoozed($, true)
  const msg = `Steward: auto-handoff ${why}. It won't start again this session unless you change /steward auto.`
  $.ui.toast(msg)
  return msg
}

// ── A-2.6 task boundary: a git commit, or Claude's whole task list completed ──
type ToolSeen = { tool: string; input: Record<string, unknown>; result: unknown; isOk: boolean }

/** Called after a tool ran. Updates the task map and, in amber/red, suggests a handoff once. */
export async function noteTool($: EngineInterface, zones: ZoneConfig, t: ToolSeen): Promise<void> {
  if (!t.isOk) return
  let why: string | null = null
  const r = (t.result ?? {}) as Record<string, any>

  if (t.tool === 'Bash' && typeof t.input.command === 'string' && isGitCommit(t.input.command)) why = 'a git commit'
  if (t.tool === 'TaskCreate' && typeof r.task?.id === 'string') await patchTasks($, { [r.task.id]: 'pending' })
  if (t.tool === 'TaskUpdate' && typeof r.taskId === 'string' && typeof r.statusChange?.to === 'string') {
    const to = r.statusChange.to as string
    const map = await patchTasks($, { [r.taskId]: to === 'deleted' ? null : (to as TaskStatus) })
    if (to === 'completed' && allDone(map)) why = 'all tasks done'
  }
  if (t.tool === 'TodoWrite' && Array.isArray(r.newTodos)) {
    const todos = r.newTodos as { status: TaskStatus }[]
    const map = await patchTasks($, Object.fromEntries(todos.map((x, i) => [`todo-${i}`, x.status])), true)
    const was = Array.isArray(r.oldTodos) && r.oldTodos.length > 0 && (r.oldTodos as { status: string }[]).every(x => x.status === 'completed')
    if (allDone(map) && !was) why = 'all tasks done'
  }
  if (!why) return

  const l = await readLive($)
  const zone = zoneOf(l.tokens, l.window, l.autoCompactAt, zones).zone
  if (!shouldSuggest(zone, await readBoundaryShown($))) return
  await showBoundary($, { why, at: await $.clock.now() })
  $.ui.toast(`Steward: ${why} at ${shortTokens(l.tokens)} (${zone}). Good moment to hand off: h in the pane.`)
}

export async function dismissBoundary($: EngineInterface): Promise<void> {
  await showBoundary($, null)
}
