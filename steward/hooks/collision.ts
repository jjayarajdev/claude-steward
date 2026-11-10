// A-6.3 / A-6.4 (PRD G-2, G-3, G-4, G-8): before Edit, Write or NotebookEdit,
// ask when another live session edited the same file within the window.
// Proceed / Move to worktree / Cancel, and Other (free text) for the model.
import type { EngineInterface } from 'claude-code'

import { touchedBy } from './core/registry'
import type { Touch } from './core/registry'
import { readOthers } from './registry'
import { noteGuard } from './state'

export const PROCEED = 'Proceed'
export const WORKTREE = 'Move to worktree'
export const CANCEL = 'Cancel'

export type Verdict = { go: true } | { go: false; reason: string }

// After Proceed, the same file is not asked about again until another session
// edits it again (a newer edit time). Per session; a reload forgets, which only
// means one extra question.
const acked = new Map<string, number>()

export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

function who(t: Touch, now: number): string {
  const task = t.task ? `"${t.task}"` : 'no prompt yet'
  return `${agoText(now - t.at)} by another session (${task}, ${t.status})`
}

/** The dialog's question: names the file, how long ago, and the other session's task. */
export function questionText(shown: string, hits: readonly Touch[], now: number): string {
  const more = hits.length > 1 ? ` ${hits.length - 1} more session${hits.length > 2 ? 's' : ''} edited it too.` : ''
  return `${shown} was edited ${who(hits[0]!, now)}.${more} Editing it here may overwrite that work. How should I proceed?`
}

/** G-4: what the model reads for each outcome. */
export function denyText(answer: string, shown: string, hits: readonly Touch[], now: number): string {
  const ctx = `another session edited ${shown} ${agoText(now - hits[0]!.at)}${hits[0]!.task ? ` ("${hits[0]!.task}")` : ''}`
  if (answer === CANCEL) return `Steward Collision Guard: the user cancelled this edit because ${ctx}. The edit was not made. Do not retry it or change the file another way; ask the user how to continue.`
  if (answer === WORKTREE) return `Steward Collision Guard: ${ctx}, so the user chose to move this work to a git worktree. Call EnterWorktree first, then make this edit again there.`
  return `Steward Collision Guard: ${ctx}; the user paused this edit with an instruction: "${answer}"`
}

/** Nothing is written before the person chooses. Headless: fail open, logged (G-8). */
export async function collisionVerdict($: EngineInterface, file: string, windowMs: number): Promise<Verdict> {
  const others = await readOthers($)
  if (!others.length) return { go: true } // G-7: alone, no effect
  const now = await $.clock.now()
  const hits = touchedBy(others, file, now, windowMs)
  if (!hits.length) return { go: true }
  const newest = hits[0]!.at
  const seen = acked.get(file)
  if (seen !== undefined && seen >= newest) return { go: true }

  const root = await $.session.root()
  const shown = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
  if (!(await $.session.surfaces()).length) {
    $.ui.log(`steward: collision on ${shown} (${who(hits[0]!, now)}); headless, so the edit was allowed`, { to: 'debug' })
    return { go: true }
  }
  let answer: string
  try {
    answer = await $.ui.ask(questionText(shown, hits, now), { header: 'Collision', options: [PROCEED, WORKTREE, CANCEL] })
  } catch {
    answer = CANCEL // dismissed: nothing was chosen, so nothing is written
  }
  if (answer === PROCEED) {
    acked.set(file, newest)
    await noteGuard($, { kind: 'collision', target: shown, outcome: 'proceeded', at: now })
    return { go: true }
  }
  await noteGuard($, { kind: 'collision', target: shown, outcome: 'blocked', at: now })
  return { go: false, reason: denyText(answer, shown, hits, now) }
}
