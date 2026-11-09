// A-3.1 handoff brief generator: ground truth → model brief → assembled markdown.
// A-3.2/3.3 (confirm, persist, clear, re-seed) build on `generateBrief`.
import type { EngineInterface } from 'claude-code'

import { BRIEF_PROMPT, assembleBrief, briefStats, estimateTokens, parseActivities, transcriptText } from './core/brief'
import type { BriefModel, Ground, Msg } from './core/brief'
import { setBriefs, dropEditing, dropPending, readEditing, readHandoff, readPending, saveEditing, saveLastBrief, savePending, setHandoff } from './state'

const ACTIVITY_FILES = ['requirements/ACTIVITIES.md', 'ACTIVITIES.md', 'docs/ACTIVITIES.md', 'PLAN.md', 'TODO.md']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'])
const DAY = 24 * 60 * 60 * 1000

async function findActivities($: EngineInterface, root: string): Promise<Ground['activities']> {
  for (const f of ACTIVITY_FILES) {
    const p = `${root}/${f}`
    if (!(await $.fs.exists(p))) continue
    const rows = parseActivities(await $.fs.read(p))
    if (rows.length) return { file: f, rows }
  }
  return null
}

async function gitStatus($: EngineInterface, root: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'status', '--short', '--branch'], { cwd: root, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

/** Newest files changed in the last day, 3 levels deep, skipping dot and build folders. */
async function recentFiles($: EngineInterface, root: string, now: number): Promise<Ground['recent']> {
  const found: Ground['recent'] = []
  let visited = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (visited > 60) return
    visited++
    let entries
    try { entries = await $.fs.list(rel ? `${root}/${rel}` : root) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isLink) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'file' && now - e.mtimeMs < DAY) found.push({ path: p, mtimeMs: e.mtimeMs })
      else if (e.kind === 'dir' && depth < 3 && !SKIP_DIRS.has(e.name)) await walk(p, depth + 1)
    }
  }
  await walk('', 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12)
}

export async function gatherGround($: EngineInterface, now: number): Promise<Ground> {
  const root = await $.session.root()
  const [activities, git, recent] = await Promise.all([
    findActivities($, root).catch(() => null),
    gitStatus($, root),
    recentFiles($, root, now).catch(() => []),
  ])
  return { activities, git, recent }
}

export type Brief = { text: string; tokens: number; source: string; ms: number }

/**
 * H-6: `session` forks the main thread (reads the transcript through the prompt
 * cache, cheapest); `sonnet`/`haiku` send a trimmed transcript to `$.model.complete`.
 * A fork with nothing to fork yet falls back to sonnet.
 */
async function modelBrief($: EngineInterface, model: BriefModel): Promise<{ text: string; source: string }> {
  if (model === 'session') {
    const r = await $.model.fork({ prompt: BRIEF_PROMPT, effort: 'low' })
    if (r.isAnswered && r.text.trim()) return { text: r.text.trim(), source: 'session model (fork)' }
    if (!r.isAnswered && r.reason !== 'nothing-to-fork') throw new Error(`brief fork failed: ${r.reason}`)
  }
  const use = model === 'session' ? 'sonnet' : model
  const msgs: Msg[] = (await $.session.messages()).map(m => ({ role: m.role, text: m.text, tools: m.toolUses.map(t => t.tool) }))
  const r = await $.model.complete({
    model: use,
    system: 'You write handoff briefs for coding sessions.',
    prompt: [{ text: `<transcript>\n${transcriptText(msgs)}\n</transcript>` }, { text: BRIEF_PROMPT }],
    maxTokens: 1200,
  })
  if (!r.isAnswered || !r.text.trim()) throw new Error(`brief model failed: ${r.isAnswered ? 'empty reply' : r.reason}`)
  return { text: r.text.trim(), source: `${use} (transcript)` }
}

export async function generateBrief($: EngineInterface, model: BriefModel): Promise<Brief> {
  const t0 = await $.clock.now()
  const [ground, mb] = await Promise.all([gatherGround($, t0), modelBrief($, model)])
  const now = await $.clock.now()
  const header = `# Handoff brief · ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const text = assembleBrief(mb.text, ground, now, header)
  return { text, tokens: estimateTokens(text), source: mb.source, ms: now - t0 }
}

async function saveBrief($: EngineInterface, b: Brief, prefix: string): Promise<{ file: string; rel: string }> {
  const root = await $.session.root()
  const now = await $.clock.now()
  const rel = `.claude/handoffs/${prefix}${new Date(now).toISOString().replace(/[:.]/g, '-')}.md`
  const file = `${root}/${rel}`
  await $.fs.write(file, b.text)
  await saveLastBrief($, { text: b.text, at: now, file })
  await refreshBriefs($)
  return { file, rel }
}

/** `/steward brief`: generate and save a preview, without clearing anything (A-3.1 check). */
export async function previewBrief($: EngineInterface, model: BriefModel): Promise<string> {
  const b = await generateBrief($, model)
  const { file } = await saveBrief($, b, 'preview-')
  return `Brief preview: ~${b.tokens} tokens (budget 2000), ${b.source}, ${(b.ms / 1000).toFixed(1)}s. Saved to ${file}. Nothing was cleared.`
}

// ── A-3.2 confirm (PRD H-2) ──
// The model setting comes from register(); a reload runs register again, so it stays current.
let briefModel: BriefModel = 'session'
export const useBriefModel = (m: BriefModel): void => { briefModel = m }

export const PROCEED = 'Proceed'
export const EDIT = 'Edit brief first'
export const CANCEL = 'Cancel'

/**
 * Band H, pane h, /steward handoff. Returns at once: the band shows "writing
 * handoff brief …" while the model works, then the confirm dialog asks.
 * `auto` (the A-2.4 countdown) skips the dialog: that path is A-3.5.
 */
export async function startHandoff($: EngineInterface, auto = false): Promise<string> {
  if ((await readHandoff($)).phase === 'writing') return 'A handoff brief is already being written.'
  // Pane h while an edited brief sits in the prompt box: offer to use it.
  if (!auto && (await isEditedBrief($, (await $.prompt.read()).text))) {
    $.clock.after(50, () => { void confirmEdited($) })
    return 'Using the edited brief in the prompt box.'
  }
  await setHandoff($, { phase: 'writing' })
  if (auto) {
    autoRun = { aborted: null }
    $.clock.after(50, () => { void writeAndHandOff($) })
    return 'Auto-handoff: writing the brief, then clearing (no dialog).'
  }
  $.clock.after(50, () => { void writeAndConfirm($) })
  return 'Writing the handoff brief (about 10 s). A confirm dialog follows; nothing is cleared without it.'
}

// ── A-3.5 auto mode (PRD H-7, C-6): no dialog, but typing or a new turn while
// the brief is written stops it before anything is cleared. ──
let autoRun: { aborted: string | null } | null = null

/** turn.start / prompt.change while an auto brief is being written. */
export async function abortAutoWrite($: EngineInterface, why: string): Promise<void> {
  if (!autoRun || autoRun.aborted) return
  autoRun.aborted = why
  await setHandoff($, { phase: 'idle' })
}

async function writeAndHandOff($: EngineInterface): Promise<void> {
  const run = autoRun
  try {
    const b = await generateBrief($, briefModel)
    const { rel } = await saveBrief($, b, '')
    const busy = (await $.prompt.read()).text.trim() !== ''
    if (run?.aborted || busy) {
      if ((await readHandoff($)).phase === 'writing') await setHandoff($, { phase: 'idle' })
      $.ui.toast(`Steward: auto-handoff stopped (${run?.aborted ?? 'you started typing'}). Nothing was cleared; the brief is at ${rel}.`)
      return
    }
    await handOff($, b.text, rel) // band stays "writing" until the new session shows "arrived"
  } catch (err) {
    await setHandoff($, { phase: 'idle' })
    $.ui.toast(`Steward: auto-handoff brief failed (${String(err)}). Nothing was cleared.`)
  } finally {
    if (autoRun === run) autoRun = null
  }
}

async function writeAndConfirm($: EngineInterface): Promise<void> {
  let b: Brief, rel: string
  try {
    b = await generateBrief($, briefModel)
    rel = (await saveBrief($, b, '')).rel
  } catch (err) {
    await setHandoff($, { phase: 'idle' })
    $.ui.toast(`Steward: handoff brief failed (${String(err)}). Nothing was cleared.`)
    return
  } finally {
    // The dialog takes over from the band.
    if ((await readHandoff($)).phase === 'writing') await setHandoff($, { phase: 'idle' })
  }

  let answer: string
  try {
    answer = await $.ui.ask(
      `Brief ready (~${b.tokens} tokens): ${briefStats(b.text)}. Saved to ${rel}. Hand off to a fresh session?`,
      { header: 'Handoff', options: [PROCEED, EDIT, CANCEL] },
    )
  } catch {
    // Dismissed, or no one to ask (-p): never clear without a yes.
    $.ui.toast(`Steward: handoff not started. The brief is kept at ${rel}.`)
    return
  }

  if (answer === PROCEED) {
    await handOff($, b.text, rel)
  } else if (answer === EDIT) {
    const r = await $.prompt.fill({ text: b.text })
    if (r.isFilled) {
      await saveEditing($, { at: await $.clock.now(), rel })
      $.ui.toast('Steward: edit the brief in the prompt box, then press Enter to hand off with it. It is not sent to this session.')
    } else {
      $.ui.toast(`Steward: couldn't fill the prompt box; the brief is at ${rel}.`)
    }
  } else if (answer === CANCEL) {
    $.ui.toast(`Steward: handoff cancelled. The brief is kept at ${rel}.`)
  } else {
    $.ui.toast(`Steward: handoff not started ("${answer.slice(0, 60)}"). The brief is kept at ${rel}.`)
  }
}

// ── A-3.3 persist → /clear → re-seed (PRD H-3, H-4; spike A-0.2) ──
const HEADER = '# Handoff brief'
const EDIT_MAX_AGE_MS = 60 * 60 * 1000
const PENDING_MAX_AGE_MS = 2 * 60 * 1000

/** Brief is already in .claude/handoffs/ (H-4); the store copy crosses the /clear. */
async function handOff($: EngineInterface, brief: string, rel: string): Promise<void> {
  await savePending($, { brief, at: await $.clock.now(), rel })
  $.ui.toast('Steward: handing off. Clearing the session; the brief will be in the new prompt box.')
  // The command or dialog must finish first: /clear needs an idle session.
  $.clock.after(300, () => {
    void $.command.run({ command: 'clear' }).catch(async err => {
      await dropPending($)
      await setHandoff($, { phase: 'idle' })
      $.ui.toast(`Steward: /clear failed (${String(err)}). Nothing was lost; the brief is at ${rel}.`)
    })
  })
}

async function isEditedBrief($: EngineInterface, text: string): Promise<boolean> {
  if (!text.trimStart().startsWith(HEADER)) return false
  const ed = await readEditing($)
  return !!ed && (await $.clock.now()) - ed.at < EDIT_MAX_AGE_MS
}

async function useEdited($: EngineInterface, text: string): Promise<void> {
  const ed = await readEditing($)
  await dropEditing($)
  const rel = ed?.rel ?? '.claude/handoffs/edited.md'
  await $.fs.write(`${await $.session.root()}/${rel}`, text.trimEnd() + '\n') // keep the edited version on disk
  await saveLastBrief($, { text, at: await $.clock.now(), file: rel })
  await refreshBriefs($)
  await handOff($, text, rel)
}

async function confirmEdited($: EngineInterface): Promise<void> {
  const text = (await $.prompt.read()).text
  let a: string
  try {
    a = await $.ui.ask('Hand off with the edited brief in the prompt box?', { header: 'Handoff', options: [PROCEED, CANCEL] })
  } catch { return }
  if (a === PROCEED) await useEdited($, text)
}

/**
 * prompt.submit: Enter on an edited brief hands off with it instead of sending it
 * to this session. Returns the drop reason, or null to let the prompt through.
 */
export async function catchEditedBrief($: EngineInterface, text: string, isOwn: boolean): Promise<string | null> {
  if (!isOwn || !(await isEditedBrief($, text))) return null
  await useEdited($, text)
  return 'Steward: not sent here. Handing off with your edited brief.'
}

/** session.end with reason `clear`: refill the fresh prompt box, retrying while it mounts. */
export function scheduleReseed($: EngineInterface, attempt = 1): void {
  $.clock.after(attempt === 1 ? 600 : 1000, () => { void reseed($, attempt) })
}

async function reseed($: EngineInterface, attempt: number): Promise<void> {
  const p = await readPending($)
  if (!p) return // a plain /clear: nothing to do
  if ((await $.clock.now()) - p.at > PENDING_MAX_AGE_MS) {
    await dropPending($)
    $.ui.toast(`Steward: the handoff brief expired before it arrived. It is at ${p.rel}.`)
    return
  }
  const r = await $.prompt.fill({ text: p.brief })
  if (r.isFilled) {
    await dropPending($)
    await setHandoff($, { phase: 'arrived' })
    $.ui.toast('Steward: ✓ handoff arrived. Review the brief in the prompt box, then send it.')
    $.clock.after(20_000, () => {
      void readHandoff($).then(h => (h.phase === 'arrived' ? setHandoff($, { phase: 'idle' }) : undefined))
    })
    return
  }
  if (attempt >= 10) {
    await dropPending($)
    $.ui.toast(`Steward: couldn't fill the new prompt box. Paste the brief from ${p.rel}.`)
    return
  }
  scheduleReseed($, attempt + 1)
}

// ── A-3.4 /steward fresh (PRD H-5): a clean /clear, always confirmed ──
export const FRESH = 'Start fresh'

export async function startFresh($: EngineInterface): Promise<string> {
  if ((await readHandoff($)).phase === 'writing') return 'A handoff brief is being written; wait for its dialog.'
  $.clock.after(50, () => { void confirmFresh($) })
  return 'Fresh start: confirm in the dialog.'
}

async function confirmFresh($: EngineInterface): Promise<void> {
  let a: string
  try {
    a = await $.ui.ask(
      "Start a fresh session? This session's context is dropped and no handoff brief is written.",
      { header: 'Fresh', options: [FRESH, CANCEL] },
    )
  } catch { return } // dismissed or headless: never clear without a yes
  if (a !== FRESH) { $.ui.toast('Steward: fresh start cancelled.'); return }
  await dropPending($) // a stale brief must not re-seed a fresh start
  await dropEditing($)
  $.clock.after(300, () => {
    void $.command.run({ command: 'clear' }).catch(err => {
      $.ui.toast(`Steward: /clear failed (${String(err)}).`)
    })
  })
}

// ── A-3.6 pane HANDOFFS: newest briefs on disk, and how many this week ──
export async function refreshBriefs($: EngineInterface): Promise<void> {
  const dir = `${await $.session.root()}/.claude/handoffs`
  let entries
  try { entries = await $.fs.list(dir) } catch { await setBriefs($, { list: [], week: 0 }); return }
  const now = await $.clock.now()
  const md = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  await setBriefs($, {
    list: md.slice(0, 5).map(e => ({ name: e.name, path: `${dir}/${e.name}`, at: e.mtimeMs, preview: e.name.startsWith('preview-') })),
    week: md.filter(e => !e.name.startsWith('preview-') && now - e.mtimeMs < 7 * DAY).length,
  })
}
