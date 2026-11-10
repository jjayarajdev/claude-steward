// A-6.7: the session's guard timings (module memory; a reload starts them over).
import type { EngineInterface } from 'claude-code'

import { BUDGET_MS, perfLine, record } from './core/perf'
import type { Samples } from './core/perf'

let samples: Samples = {}

/** Wall time, from the runtime itself: no engine call, so timing can never fail a guard. */
export const perfNow = (): number => Date.now()

/** Notes how long a guard took to decide; a slow one is also logged to debug. */
export async function notePerf($: EngineInterface, name: string, startedAt: number): Promise<void> {
  const ms = perfNow() - startedAt
  samples = record(samples, name, ms)
  if (ms > BUDGET_MS) $.ui.log(`steward: ${name} took ${ms} ms (budget ${BUDGET_MS} ms)`, { to: 'debug' })
}

/** `/steward perf` */
export function perfReport(): string {
  const names = ['collision check', 'blast check']
  return ['Guard decision times this session (before any dialog; your time in a dialog is not counted):', ...names.map(n => `  ${perfLine(n, samples[n] ?? [])}`)].join('\n')
}
