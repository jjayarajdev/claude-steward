// Pure: prompt-cache countdown (PRD K-1, K-2, K-8, K-9). The API never says when
// the cache expires, so everything here is an estimate from the last main-thread
// response plus a TTL the person sets (`/steward ttl <min>`).

export const DEFAULT_TTL_MINUTES = 60
export const TTL_KEY = 'ttlMinutes'

export type Hit = { read: number; written: number; isHit: boolean }

export type Countdown = {
  /** null before the first response this session (K-8: no countdown yet). */
  minutesLeft: number | null
  secondsLeft: number | null
  isCold: boolean
}

/** Rounded UP so "1m" lasts until the last minute, then the seconds take over. */
export function countdown(lastAt: number | null, now: number, ttlMinutes: number): Countdown {
  if (lastAt === null) return { minutesLeft: null, secondsLeft: null, isCold: false }
  const msLeft = lastAt + ttlMinutes * 60_000 - now
  if (msLeft <= 0) return { minutesLeft: null, secondsLeft: null, isCold: true }
  return { minutesLeft: Math.ceil(msLeft / 60_000), secondsLeft: Math.ceil(msLeft / 1000), isCold: false }
}

/** A-4.2: 15 s ticks, 1 s in the last minute, none once cold or before the first reply. */
export function nextTickMs(c: Countdown): number | null {
  if (c.isCold || c.secondsLeft === null) return null
  // Above the last minute: every 15 s, but land on the 60 s mark so 1 s ticks start on time.
  return c.secondsLeft <= 60 ? 1000 : Math.max(1000, Math.min(15_000, (c.secondsLeft - 60) * 1000))
}

/**
 * K-9 from a turn's summed usage. A turn reads the cache on every request after
 * its first, so "hit" means it read more than it wrote: a cold start writes the
 * whole conversation once, which outweighs the reads of a short turn.
 */
export function hitOf(u: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): Hit {
  const read = u.cache_read_input_tokens, written = u.cache_creation_input_tokens
  return { read, written, isHit: read > 0 && read >= written }
}

/** `/steward ttl` argument: whole minutes, 1 to 1440. */
export function parseTtl(arg: string | undefined): number | string {
  if (!arg) return 'usage: /steward ttl <minutes> (1–1440), e.g. /steward ttl 5'
  const n = Number(arg.replace(/m(in)?$/i, ''))
  if (!Number.isInteger(n) || n < 1 || n > 1440) return `"${arg}" is not a whole number of minutes from 1 to 1440.`
  return n
}

/** "41m" above a minute, "45s" in the last minute. */
export const leftText = (c: Countdown): string =>
  c.secondsLeft !== null && c.secondsLeft <= 60 ? `${c.secondsLeft}s` : `${c.minutesLeft}m`

export const DEFAULT_LEAD_MINUTES = 5

/**
 * A-4.3 (K-3): when to warn, or null when there is nothing to warn about.
 * A lead as long as the window would warn right after each reply, so it is
 * capped at half the window (TTL 2, lead 5 → warn at 1 minute).
 */
export function warnAt(lastAt: number | null, ttlMinutes: number, leadMinutes: number): number | null {
  if (lastAt === null || leadMinutes <= 0) return null
  const lead = Math.min(leadMinutes, ttlMinutes / 2)
  return lastAt + (ttlMinutes - lead) * 60_000
}

export const warnText = (minutesLeft: number): string =>
  `Cache cold in ${minutesLeft}m (est.). Keep it warm (/steward ping) or hand off (/steward handoff) before you step away.`
