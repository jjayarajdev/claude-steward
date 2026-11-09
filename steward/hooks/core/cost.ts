// Pure: A-4.4 (PRD K-5) cold-cache cost of the next message, an ESTIMATE.
// A cold cache means the whole context is written to the cache again: input price
// × 1.25 for the 5-minute TTL, × 2 for the 1-hour TTL (Anthropic prompt-caching
// docs). Output and the reply itself are not counted.
// Default list prices, $ per million input tokens, from the Claude API reference
// cached 2026-10-06. First match wins; override with the `prices` setting.

export type Price = { match: string; input: number; over100k?: number }

export const DEFAULT_PRICES: readonly Price[] = [
  { match: 'fable', input: 10 },
  { match: 'mythos', input: 10 },
  { match: 'opus-5-5', input: 4 },
  { match: 'opus', input: 5 },
  { match: 'sonnet-5-5', input: 2 },
  { match: 'sonnet-5', input: 2 },
  { match: 'sonnet', input: 3 },
  { match: 'haiku-5-5', input: 0.1, over100k: 0.5 },
  { match: 'haiku', input: 1 },
]

/** "Opus 5.5 (1M context)" and "claude-opus-5-5" both become "...opus-5-5...". */
export const normModel = (m: string): string => m.toLowerCase().replace(/[\s._]+/g, '-')

/**
 * `prices` setting: "opus=4, sonnet-5-5=2" ($ per million input tokens).
 * Entries come before the defaults, so they win. Bad entries are skipped.
 */
export function parsePrices(s: string | undefined): Price[] {
  const out: Price[] = []
  for (const part of (s ?? '').split(',')) {
    const [k, v] = part.split('=').map(x => x?.trim() ?? '')
    const n = Number(v)
    if (k && Number.isFinite(n) && n >= 0) out.push({ match: normModel(k), input: n })
  }
  return [...out, ...DEFAULT_PRICES]
}

export function pricePerM(model: string | null, tokens: number, table: readonly Price[]): number | null {
  if (!model) return null
  const m = normModel(model)
  const p = table.find(x => m.includes(x.match))
  if (!p) return null
  return p.over100k !== undefined && tokens > 100_000 ? p.over100k : p.input
}

/** The whole context written to the cache again; the TTL picks the write rate. */
export function coldCostUsd(tokens: number | null, perM: number | null, ttlMinutes: number): number | null {
  if (tokens === null || perM === null || tokens <= 0) return null
  return (tokens / 1_000_000) * perM * (ttlMinutes > 5 ? 2 : 1.25)
}

export const usdText = (usd: number): string => (usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`)
