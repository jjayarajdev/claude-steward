// Pure: auto-handoff setting (PRD C-5). Saved per user, with a per-project override.

/** One saved setting. `atTokens` null = fire at the red zone's start. */
export type AutoSetting = { on: boolean; atTokens: number | null }

export type AutoView = AutoSetting & { source: 'project' | 'user' | 'default' }

export type AutoCommand =
  | { kind: 'show' }
  | { kind: 'set'; scope: 'user' | 'project'; value: AutoSetting }
  | { kind: 'reset' }
  | { kind: 'error'; message: string }

export const AUTO_DEFAULT: AutoSetting = { on: false, atTokens: null }

/** "300000", "300K", "300k", "0.4M" → tokens; anything else null. */
export function parseTokens(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1]) * (m[2] === '' ? 1 : /k/i.test(m[2] ?? '') ? 1_000 : 1_000_000)
  return Number.isFinite(n) && n >= 10_000 ? Math.round(n) : null
}

/** Parses the text after `/steward auto`. */
export function parseAuto(args: string): AutoCommand {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let scope: 'user' | 'project' = 'user'
  if (words[0] === 'here') { scope = 'project'; words.shift() }
  const w = words[0]
  if (w === undefined) return scope === 'project' ? { kind: 'error', message: 'Usage: /steward auto here on|off|<tokens>|reset' } : { kind: 'show' }
  if (w === 'reset') return scope === 'project' ? { kind: 'reset' } : { kind: 'error', message: 'reset clears a project override: /steward auto here reset' }
  if (w === 'on') return { kind: 'set', scope, value: { on: true, atTokens: null } }
  if (w === 'off') return { kind: 'set', scope, value: { on: false, atTokens: null } }
  const t = parseTokens(w)
  if (t !== null) return { kind: 'set', scope, value: { on: true, atTokens: t } }
  return { kind: 'error', message: `Not understood: "${w}". Use on, off, or a token count like 300K (at least 10K).` }
}

/** The project override wins over the user setting, which wins over the default. */
export function resolveAuto(user: AutoSetting | null, project: AutoSetting | null): AutoView {
  if (project) return { ...project, source: 'project' }
  if (user) return { ...user, source: 'user' }
  return { ...AUTO_DEFAULT, source: 'default' }
}

/** Tokens at which auto-handoff arms: its own threshold, else the red zone's start. */
export const autoAt = (v: AutoSetting, redAt: number): number => v.atTokens ?? redAt

/** Reads a stored value defensively (the store is plain JSON). */
export function asSetting(x: unknown): AutoSetting | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.on !== 'boolean') return null
  const t = typeof o.atTokens === 'number' && o.atTokens > 0 ? o.atTokens : null
  return { on: o.on, atTokens: t }
}

export type ArmInput = {
  auto: AutoSetting
  tokens: number | null
  redAt: number
  /** The turn that just ended was the main session's (not a subagent's). */
  isMain: boolean
  /** It ended normally (not aborted, refused or errored). */
  isAnswer: boolean
  /** A countdown or handoff is already under way. */
  isBusy: boolean
  /** Cancelled earlier this session; cleared when the auto setting changes. */
  isSnoozed: boolean
}

/** A-2.4: arm the auto-handoff countdown? Only between turns, never mid-turn. */
export function shouldArm(i: ArmInput): boolean {
  if (!i.auto.on || !i.isMain || !i.isAnswer || i.isBusy || i.isSnoozed) return false
  return i.tokens !== null && i.tokens >= autoAt(i.auto, i.redAt)
}

export const COUNTDOWN_SECONDS = 10
