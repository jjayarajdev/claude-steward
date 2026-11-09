// Pure: context zones in TOKENS (PRD C-2). No engine calls, so it can be unit-tested
// and later replaced by a Rust core without touching the UI.

export type Zone = 'green' | 'amber' | 'red'

export type ZoneConfig = { amberTokens: number; redTokens: number }

export type ZoneResult = { zone: Zone; amberAt: number; redAt: number }

export const DEFAULT_ZONES: ZoneConfig = { amberTokens: 250_000, redTokens: 400_000 }

/**
 * amberAt = min(amberTokens, 50% of window)
 * redAt   = min(redTokens, 80% of autoCompactAt, or 80% of window when auto-compact is off)
 * Red always lands before the engine's own (lossy) auto-compact.
 */
export function zoneOf(
  tokens: number | null,
  window: number | null,
  autoCompactAt: number | null,
  cfg: ZoneConfig = DEFAULT_ZONES,
): ZoneResult {
  const w = window && window > 0 ? window : 1_000_000
  const ceiling = autoCompactAt && autoCompactAt > 0 ? autoCompactAt : w
  const redAt = Math.round(Math.min(cfg.redTokens, 0.8 * ceiling))
  const amberAt = Math.round(Math.min(cfg.amberTokens, 0.5 * w, redAt))
  const t = tokens ?? 0
  const zone: Zone = t >= redAt ? 'red' : t >= amberAt ? 'amber' : 'green'
  return { zone, amberAt, redAt }
}

type BreakdownLike = { autoCompactThreshold?: number; isAutoCompactEnabled: boolean } | undefined

/** The engine's real auto-compact point (C-7), or null when it is off or unknown. */
export function autoCompactFrom(b: BreakdownLike): number | null {
  if (!b || !b.isAutoCompactEnabled) return null
  const t = b.autoCompactThreshold
  return typeof t === 'number' && t > 0 ? t : null
}

/**
 * Toast text for a zone change (C-2), or null when there is nothing to say:
 * no previous reading yet, or the zone did not move.
 */
export function zoneToast(prev: Zone | null, z: ZoneResult, tokens: number | null, autoCompactAt: number | null): string | null {
  if (prev === null || prev === z.zone) return null
  const t = shortTokens(tokens)
  const ac = autoCompactAt ? `, auto-compact at ${shortTokens(autoCompactAt)}` : ''
  if (z.zone === 'red') return `Steward: context RED (${t}${ac}). Hand off now: h in the pane, or /steward handoff.`
  if (z.zone === 'amber') return prev === 'red'
    ? `Steward: context back to amber (${t}).`
    : `Steward: context amber (${t}; red at ${shortTokens(z.redAt)}). Hand off at the next task boundary.`
  return `Steward: context back to green (${t}).`
}

export const shortTokens = (n: number | null): string =>
  n === null ? '–' : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)

export const bar = (pct: number, width = 10): string => {
  const p = Math.max(0, Math.min(100, pct))
  const filled = Math.round((p / 100) * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}
