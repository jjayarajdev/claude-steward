// Pure: A-6.7 (NFR) timings of the guards' decision step: how long a tool call
// waits before running (or before its dialog opens). Time spent in a dialog is
// the person's, not Steward's, and is never counted.

export type Samples = { [name: string]: number[] }
export const KEEP = 500
export const BUDGET_MS = 50

export function record(s: Samples, name: string, ms: number): Samples {
  return { ...s, [name]: [...(s[name] ?? []), Math.max(0, ms)].slice(-KEEP) }
}

/** Nearest-rank percentile (p in 0..100) of the samples; null when none. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

export function perfLine(name: string, xs: readonly number[]): string {
  if (!xs.length) return `${name}: no calls yet`
  const p95 = percentile(xs, 95)!
  return `${name}: ${xs.length} calls · p50 ${percentile(xs, 50)} ms · p95 ${p95} ms · max ${Math.max(...xs)} ms ${p95 <= BUDGET_MS ? '✓' : `✗ over the ${BUDGET_MS} ms budget`}`
}
