// A-3.1 handoff brief (PRD H-1, H-6). Pure: no engine calls, so it is unit-tested.
// The model writes the narrative part from the conversation. Steward then appends
// ground truth it reads itself (A-0.8 finding: a conversation-only brief was out of
// date) and a fixed closing instruction (the fresh session acted at once on "Next step").

export type BriefModel = 'session' | 'sonnet' | 'haiku'

export const BRIEF_PROMPT = `Write a handoff brief so a fresh Claude Code session can continue this work. The reader has none of this conversation.

Markdown, under 350 words, these headings exactly and in this order:
## Goal
## Decisions made
## Current state
## Open tasks
## Key files
## Next step

Rules: be concrete (names, paths, commands, numbers). Under Current state, separate what was verified from what is assumed. Say what the user has and has not approved. No preamble, no closing remarks.`

export const CLOSING = `## Before you start
This brief was written at handoff time and may be incomplete or out of date. **Confirm the current state and the plan with the user before changing anything.** Do not start on "Next step" until they agree.`

export type ActivityRow = { id: string; name: string; status: string }

export type Ground = {
  activities: { file: string; rows: ActivityRow[] } | null
  git: string | null // `git status --short --branch`, or null outside a repo
  recent: { path: string; mtimeMs: number }[]
}

const STATUS = /^(☐|◐|☑|✕)/

/** Parses `| A-1.2 | name | … | status |` rows from a markdown activity table. */
export function parseActivities(md: string): ActivityRow[] {
  const out: ActivityRow[] = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    const id = cells[0] ?? ''
    const status = cells[cells.length - 1] ?? ''
    if (!/^[A-Z]-\d+(\.\d+)?$/.test(id) || !STATUS.test(status)) continue
    out.push({ id, name: cells[1] ?? '', status })
  }
  return out
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const plain = (s: string) => s.replace(/\*\*|`/g, '')

/** In-progress rows in full-ish, then the next few to-dos, then counts. */
export function activitiesSection(file: string, rows: ActivityRow[]): string {
  const of = (m: string) => rows.filter(r => r.status.startsWith(m))
  const done = of('☑').length, todo = of('☐'), wip = of('◐')
  const lines = [`### Activities (${file}): ${done} done, ${wip.length} in progress, ${todo.length} to do`]
  for (const r of wip) lines.push(`- ◐ ${r.id} ${cut(plain(r.name), 70)}: ${cut(plain(r.status.replace(/^◐\s*/, '')), 160)}`)
  for (const r of todo.slice(0, 4)) lines.push(`- ☐ ${r.id} ${cut(plain(r.name), 90)}`)
  if (todo.length > 4) lines.push(`- … ${todo.length - 4} more to do`)
  return lines.join('\n')
}

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export function groundSection(g: Ground, now: number): string {
  const parts = ['## Ground truth (read by Steward at handoff, not from the conversation)']
  if (g.activities) parts.push(activitiesSection(g.activities.file, g.activities.rows))
  if (g.recent.length) {
    parts.push(['### Files changed in the last 24h', ...g.recent.map(f => `- ${f.path} (${ago(now - f.mtimeMs)})`)].join('\n'))
  }
  if (g.git !== null) {
    const lines = g.git.trim().split('\n')
    const shown = lines.slice(0, 20)
    if (lines.length > 20) shown.push(`… ${lines.length - 20} more`)
    parts.push(['### git status', '```', ...shown, '```'].join('\n'))
  } else {
    parts.push('### git status\nNot a git repository.')
  }
  return parts.join('\n\n')
}

/** ~4 characters per token: a cheap local estimate, good enough for the 2K budget. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4)

export const BUDGET_TOKENS = 2000

export function assembleBrief(modelText: string, g: Ground, now: number, header: string): string {
  const build = (gr: Ground) => [header, modelText.trim(), groundSection(gr, now), CLOSING].join('\n\n') + '\n'
  let out = build(g)
  // Over budget: shed ground truth detail first (files, then to-dos), never the closing.
  if (estimateTokens(out) > BUDGET_TOKENS && g.recent.length > 5) out = build(g = { ...g, recent: g.recent.slice(0, 5) })
  if (estimateTokens(out) > BUDGET_TOKENS && g.activities) {
    const rows = g.activities.rows.filter(r => !r.status.startsWith('☐'))
    out = build({ ...g, activities: { ...g.activities, rows } })
  }
  return out
}

export type Msg = { role: 'user' | 'assistant'; text: string; tools: string[] }

/**
 * Transcript for a non-session model (`$.model.complete` cannot read the prompt
 * cache): newest messages first until the character budget is spent, then back
 * in order. Long messages are clipped in the middle.
 */
export function transcriptText(msgs: readonly Msg[], budget = 120_000): string {
  const out: string[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    let t = m.text.trim()
    if (t.length > 3000) t = `${t.slice(0, 1500)}\n[…]\n${t.slice(-1200)}`
    const tools = m.tools.length ? ` [tools: ${m.tools.slice(0, 8).join(', ')}${m.tools.length > 8 ? ', …' : ''}]` : ''
    if (!t && !tools) continue
    const line = `${m.role.toUpperCase()}:${tools} ${t}`
    if (out.length && used + line.length > budget) break
    out.push(line)
    used += line.length
  }
  return out.reverse().join('\n\n')
}

export const parseBriefModel = (v: unknown): BriefModel =>
  v === 'sonnet' || v === 'haiku' ? v : 'session'

/** "goal, 5 decisions, 3 open tasks" for the confirm dialog (DESIGN handoff confirm). */
export function briefStats(md: string): string {
  const count = (h: string) => {
    const at = md.indexOf(`## ${h}`)
    if (at < 0) return 0
    const end = md.indexOf('\n## ', at + 3)
    return md.slice(at, end < 0 ? undefined : end).split('\n').filter(l => /^\s*[-*] /.test(l)).length
  }
  const d = count('Decisions made'), t = count('Open tasks')
  return `${md.includes('## Goal') ? 'goal, ' : ''}${d} decision${d === 1 ? '' : 's'}, ${t} open task${t === 1 ? '' : 's'}`
}
