import { expect, test } from 'claude-code/testing'

import { bandWidth, fitBand, isFreeHandoff, resolveBand } from '../hooks/core/band'
import type { BandInput } from '../hooks/core/band'
import { asSetting, autoAt, parseAuto, resolveAuto, shouldArm } from '../hooks/core/auto'
import { allDone, isGitCommit, shouldSuggest } from '../hooks/core/boundary'
import { CLOSING, activitiesSection, briefStats, assembleBrief, estimateTokens, parseActivities, parseBriefModel, transcriptText } from '../hooks/core/brief'
import { countdown, hitOf, leftText, nextTickMs, parseTtl, warnAt } from '../hooks/core/cache'
import { coldCostUsd, parsePrices, pricePerM, usdText } from '../hooks/core/cost'
import { resetIn } from '../hooks/core/time'
import { autoCompactFrom, zoneOf, zoneToast } from '../hooks/core/zones'

// ── zones (PRD C-2) ──
test('1M window, no auto-compact: amber 250K, red 400K', async () => {
  const z = zoneOf(196_000, 1_000_000, null)
  expect(z.amberAt).toBe(250_000)
  expect(z.redAt).toBe(400_000)
  expect(z.zone).toBe('green')
  expect(zoneOf(300_000, 1_000_000, null).zone).toBe('amber')
  expect(zoneOf(400_000, 1_000_000, null).zone).toBe('red')
})

test('200K window: amber at half the window, red before auto-compact', async () => {
  const z = zoneOf(0, 200_000, 167_000)
  expect(z.amberAt).toBe(100_000)
  expect(z.redAt).toBe(133_600)
  expect(z.redAt < 167_000).toBe(true)
})

test('red never sits after auto-compact, amber never after red', async () => {
  const z = zoneOf(0, 1_000_000, 300_000)
  expect(z.redAt).toBe(240_000)
  expect(z.amberAt <= z.redAt).toBe(true)
})

test('200K window, auto-compact off: red at 80% of the window', async () => {
  const z = zoneOf(0, 200_000, null)
  expect(z.amberAt).toBe(100_000)
  expect(z.redAt).toBe(160_000)
})

test('1M window with real auto-compact point: red stays at 400K', async () => {
  expect(zoneOf(0, 1_000_000, 967_000).redAt).toBe(400_000)
})

test('auto-compact point read from the breakdown (A-2.2)', async () => {
  expect(autoCompactFrom({ isAutoCompactEnabled: true, autoCompactThreshold: 167_000 })).toBe(167_000)
  expect(autoCompactFrom({ isAutoCompactEnabled: false, autoCompactThreshold: 167_000 })).toBe(null)
  expect(autoCompactFrom({ isAutoCompactEnabled: true })).toBe(null)
  expect(autoCompactFrom(undefined)).toBe(null)
})

test('zone toast only on change', async () => {
  const at = (t: number) => zoneOf(t, 1_000_000, 967_000)
  expect(zoneToast(null, at(300_000), 300_000, 967_000)).toBe(null)
  expect(zoneToast('amber', at(300_000), 300_000, 967_000)).toBe(null)
  expect(zoneToast('green', at(300_000), 300_000, 967_000)?.includes('amber')).toBe(true)
  expect(zoneToast('amber', at(410_000), 410_000, 967_000)?.includes('RED')).toBe(true)
  expect(zoneToast('red', at(300_000), 300_000, 967_000)?.includes('back to amber')).toBe(true)
  expect(zoneToast('amber', at(20_000), 20_000, 967_000)?.includes('back to green')).toBe(true)
})

test('reset times (A-2.5)', async () => {
  const now = Date.parse('2026-11-09T10:00:00Z')
  expect(resetIn(null, now)).toBe(null)
  expect(resetIn('garbage', now)).toBe(null)
  expect(resetIn('2026-11-09T09:59:00Z', now)).toBe('resetting now')
  expect(resetIn('2026-11-09T10:42:00Z', now)).toBe('resets in 42m')
  expect(resetIn('2026-11-09T12:14:00Z', now)).toBe('resets in 2h 14m')
  expect(resetIn('2026-11-12T14:00:00Z', now)).toBe('resets in 3d 4h')
})

// ── band priority (DESIGN §2.2) ──
const base: BandInput = {
  zone: 'green', pct: 20, tokensText: '196K / 1M',
  cache: { minutesLeft: 50, isCold: false }, handoff: 'idle', countdownSeconds: 0,
  others: { count: 0, task: null }, usage: { fiveHour: 18, week: 9, usd: 2.4 },
  paneUp: false, quiet: false,
}

test('priority order', async () => {
  const state = (i: Partial<BandInput>) => resolveBand({ ...base, ...i })?.state
  expect(state({})).toBe('calm')
  expect(state({ others: { count: 1, task: 'x' } })).toBe('other')
  expect(state({ cache: { minutesLeft: 8, isCold: false } })).toBe('cache-warn')
  expect(state({ zone: 'amber', cache: { minutesLeft: 8, isCold: false } })).toBe('ctx-amber')
  expect(state({ zone: 'amber', cache: { minutesLeft: null, isCold: true } })).toBe('cache-cold')
  expect(state({ zone: 'red', cache: { minutesLeft: null, isCold: true } })).toBe('ctx-red')
  expect(state({ zone: 'red', cache: { minutesLeft: 3, isCold: false } })).toBe('cache-soon')
  expect(state({ zone: 'red', handoff: 'countdown', countdownSeconds: 10 })).toBe('handoff')
})

test('pane up: band silent unless alert', async () => {
  expect(resolveBand({ ...base, paneUp: true })).toBe(null)
  expect(resolveBand({ ...base, paneUp: true, others: { count: 1, task: 'x' } })).toBe(null)
  expect(resolveBand({ ...base, paneUp: true, zone: 'amber' })?.state).toBe('ctx-amber')
})

test('pane closed: band offers the Steward button; quiet hides calm', async () => {
  expect(resolveBand(base)?.actions.at(-1)?.id).toBe('pane')
  expect(resolveBand({ ...base, quiet: true })).toBe(null)
  expect(resolveBand({ ...base, quiet: true, zone: 'red' })?.state).toBe('ctx-red')
})

// ── width (DESIGN §2.3) ──
test('narrowing drops cost, then week, then 5h; under 40 is compact', async () => {
  const v = resolveBand(base)
  if (!v) throw new Error('expected a band')
  const full = bandWidth(v)
  const ids = (cols: number) => fitBand(v, cols).segments.map(s => s.id).join(',')
  expect(ids(full)).toBe('cache,five,week,cost')
  expect(ids(full - 5)).toBe('cache,five,week')
  expect(ids(full - 14)).toBe('cache,five')
  const compact = fitBand(v, 30)
  expect(compact.segments.length).toBe(0)
  expect(compact.actions.length).toBe(1)
})

// ── auto-handoff setting (A-2.3) ──
test('auto command parsing', async () => {
  expect(parseAuto('').kind).toBe('show')
  expect(parseAuto('on')).toEqual({ kind: 'set', scope: 'user', value: { on: true, atTokens: null } })
  expect(parseAuto('off')).toEqual({ kind: 'set', scope: 'user', value: { on: false, atTokens: null } })
  expect(parseAuto('300K')).toEqual({ kind: 'set', scope: 'user', value: { on: true, atTokens: 300_000 } })
  expect(parseAuto('here 0.4M')).toEqual({ kind: 'set', scope: 'project', value: { on: true, atTokens: 400_000 } })
  expect(parseAuto('here reset').kind).toBe('reset')
  expect(parseAuto('reset').kind).toBe('error')
  expect(parseAuto('50%').kind).toBe('error')
  expect(parseAuto('5000').kind).toBe('error')
})

test('auto: project overrides user overrides default; threshold falls back to red', async () => {
  expect(resolveAuto(null, null)).toEqual({ on: false, atTokens: null, source: 'default' })
  expect(resolveAuto({ on: true, atTokens: null }, null).source).toBe('user')
  expect(resolveAuto({ on: true, atTokens: null }, { on: false, atTokens: null })).toEqual({ on: false, atTokens: null, source: 'project' })
  expect(autoAt({ on: true, atTokens: null }, 400_000)).toBe(400_000)
  expect(autoAt({ on: true, atTokens: 300_000 }, 400_000)).toBe(300_000)
  expect(asSetting({ on: 'yes' })).toBe(null)
  expect(asSetting({ on: true, atTokens: -1 })).toEqual({ on: true, atTokens: null })
})

// ── auto-handoff arming (A-2.4) ──
test('arms only between main turns, past the threshold, when on and not snoozed', async () => {
  const base = { auto: { on: true, atTokens: null }, tokens: 410_000, redAt: 400_000, isMain: true, isAnswer: true, isBusy: false, isSnoozed: false }
  expect(shouldArm(base)).toBe(true)
  expect(shouldArm({ ...base, auto: { on: false, atTokens: null } })).toBe(false)
  expect(shouldArm({ ...base, tokens: 390_000 })).toBe(false)
  expect(shouldArm({ ...base, tokens: 310_000, auto: { on: true, atTokens: 300_000 } })).toBe(true)
  expect(shouldArm({ ...base, isMain: false })).toBe(false)      // subagent turn
  expect(shouldArm({ ...base, isAnswer: false })).toBe(false)    // aborted / error
  expect(shouldArm({ ...base, isBusy: true })).toBe(false)       // already counting
  expect(shouldArm({ ...base, isSnoozed: true })).toBe(false)    // cancelled earlier
  expect(shouldArm({ ...base, tokens: null })).toBe(false)       // fresh session
})

// ── task boundary (A-2.6) ──
test('git commit detection', async () => {
  expect(isGitCommit('git commit -m "x"')).toBe(true)
  expect(isGitCommit('git add . && git commit -m "wip"')).toBe(true)
  expect(isGitCommit('git -C repo commit --amend')).toBe(true)
  expect(isGitCommit('GIT_AUTHOR_NAME=a git commit -m x')).toBe(true)
  expect(isGitCommit('git status')).toBe(false)
  expect(isGitCommit('git commit-tree abc')).toBe(false)
  expect(isGitCommit('echo "git commit later"')).toBe(false)
  expect(isGitCommit('git log --grep commit')).toBe(false)
})

test('all tasks done, and suggestion only in amber/red once', async () => {
  expect(allDone({})).toBe(false)
  expect(allDone({ a: 'completed', b: 'in_progress' })).toBe(false)
  expect(allDone({ a: 'completed', b: 'completed' })).toBe(true)
  expect(shouldSuggest('green', false)).toBe(false)
  expect(shouldSuggest('amber', false)).toBe(true)
  expect(shouldSuggest('red', true)).toBe(false)
})

// ── free-handoff moment (A-2.7, C-9) ──
test('cache cold in amber or red: handoff costs nothing extra', async () => {
  expect(isFreeHandoff('green', { isCold: true })).toBe(false)
  expect(isFreeHandoff('amber', { isCold: false })).toBe(false)
  expect(isFreeHandoff('amber', { isCold: true })).toBe(true)
  expect(isFreeHandoff('red', null)).toBe(false)
  const cold = { minutesLeft: null, isCold: true }
  expect(resolveBand({ ...base, zone: 'amber', cache: cold })?.lead.includes('costs nothing extra')).toBe(true)
  expect(resolveBand({ ...base, zone: 'red', cache: cold })?.lead.includes('costs nothing extra')).toBe(true)
  expect(resolveBand({ ...base, zone: 'green', cache: cold })?.lead).toBe('cache cold (est.)')
})

// ── handoff brief (A-3.1, H-1, A-0.8) ──
const TABLE = [
  '| ID | Activity | Reqs | Est | Depends | Done when | Status |',
  '|---|---|---|---|---|---|---|',
  '| A-2.6 | Task boundary | C-8 | 1.5 | A-2.2 | – | ☑ 2026-11-09: done |',
  '| A-2.7 | Cache cold hint | C-9 | 0.5 | A-4.2 | – | ◐ 2026-11-09: demo added |',
  '| A-3.1 | Brief template | H-1 | 2 | A-1.1 | Under 2K | ☐ |',
  '| A-3.2 | Confirm dialog | H-2 | 1 | A-3.1 | – | ☐ |',
].join('\n')

test('activity table: parses rows, shows in-progress and next to-dos', async () => {
  const rows = parseActivities(TABLE)
  expect(rows.map(r => r.id).join(',')).toBe('A-2.6,A-2.7,A-3.1,A-3.2')
  const sec = activitiesSection('ACTIVITIES.md', rows)
  expect(sec.includes('1 done, 1 in progress, 2 to do')).toBe(true)
  expect(sec.includes('◐ A-2.7')).toBe(true)
  expect(sec.includes('☐ A-3.1')).toBe(true)
  expect(sec.includes('A-2.6')).toBe(false)
})

test('brief: ground truth appended and always ends with confirm-first', async () => {
  const now = Date.UTC(2026, 10, 9, 12)
  const g = { activities: { file: 'ACTIVITIES.md', rows: parseActivities(TABLE) }, git: null,
    recent: [{ path: 'hooks/handoff.ts', mtimeMs: now - 5 * 60_000 }] }
  const b = assembleBrief('## Goal\nShip it', g, now, '# Handoff brief')
  expect(b.includes('## Ground truth')).toBe(true)
  expect(b.includes('hooks/handoff.ts (5m ago)')).toBe(true)
  expect(b.includes('Not a git repository.')).toBe(true)
  expect(b.trimEnd().endsWith(CLOSING.trimEnd())).toBe(true)
  expect(estimateTokens(b) < 2000).toBe(true)
})

test('brief: over budget sheds ground detail but keeps the closing', async () => {
  const now = 1_000_000_000
  const many = Array.from({ length: 300 }, (_, i) => `| A-9.${i} | ${'x'.repeat(80)} | – | 1 | – | – | ☐ |`).join('\n')
  const g = { activities: { file: 'A.md', rows: parseActivities(many) }, git: null,
    recent: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, mtimeMs: now })) }
  const b = assembleBrief('y'.repeat(7700), g, now, '# H')
  expect(b.includes('f11.ts')).toBe(false)
  expect(b.trimEnd().endsWith(CLOSING.trimEnd())).toBe(true)
})

test('transcript: newest kept within budget, in order, tools named', async () => {
  const msgs = [
    { role: 'user' as const, text: 'old '.repeat(100), tools: [] },
    { role: 'user' as const, text: 'fix the band', tools: [] },
    { role: 'assistant' as const, text: 'done', tools: ['Edit', 'Bash'] },
  ]
  const t = transcriptText(msgs, 60)
  expect(t.includes('old')).toBe(false)
  expect(t.indexOf('USER: fix the band') < t.indexOf('ASSISTANT: [tools: Edit, Bash] done')).toBe(true)
  expect(parseBriefModel('haiku')).toBe('haiku')
  expect(parseBriefModel(undefined)).toBe('session')
})

test('confirm dialog summary counts decisions and open tasks (A-3.2)', async () => {
  const md = '## Goal\nx\n## Decisions made\n- a\n- b\n## Current state\n- c\n## Open tasks\n- d\n## Next step\ne'
  expect(briefStats(md)).toBe('goal, 2 decisions, 1 open task')
  expect(briefStats('nothing')).toBe('0 decisions, 0 open tasks')
})

// ── cache countdown (A-4.2, K-1, K-2, K-8, K-9) ──
test('cache: no countdown before the first reply, cold after the window', async () => {
  expect(countdown(null, 0, 60)).toEqual({ minutesLeft: null, secondsLeft: null, isCold: false })
  const c = countdown(0, 19 * 60_000, 60)
  expect(c.minutesLeft).toBe(41)
  expect(c.isCold).toBe(false)
  expect(countdown(0, 60 * 60_000, 60).isCold).toBe(true)
  expect(countdown(0, 5 * 60_000 - 45_000, 5).secondsLeft).toBe(45)
  expect(leftText(countdown(0, 5 * 60_000 - 45_000, 5))).toBe('45s')
  expect(leftText(c)).toBe('41m')
})

test('cache: 15 s ticks, landing on the last minute, then 1 s, none when cold', async () => {
  expect(nextTickMs(countdown(0, 0, 60))).toBe(15_000)
  expect(nextTickMs({ minutesLeft: 2, secondsLeft: 65, isCold: false })).toBe(5000)
  expect(nextTickMs({ minutesLeft: 1, secondsLeft: 60, isCold: false })).toBe(1000)
  expect(nextTickMs(countdown(0, 61 * 60_000, 60))).toBe(null)
  expect(nextTickMs(countdown(null, 0, 60))).toBe(null)
})

test('cache: hit when the turn read more than it wrote; ttl parsing', async () => {
  expect(hitOf({ cache_read_input_tokens: 228_000, cache_creation_input_tokens: 2000 }).isHit).toBe(true)
  expect(hitOf({ cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000 }).isHit).toBe(false)
  expect(parseTtl('5')).toBe(5)
  expect(parseTtl('60m')).toBe(60)
  expect(typeof parseTtl('0')).toBe('string')
  expect(typeof parseTtl('2.5')).toBe('string')
  expect(typeof parseTtl(undefined)).toBe('string')
})

test('cache warning: lead before expiry, capped at half the window, off at 0 (A-4.3)', async () => {
  expect(warnAt(0, 60, 5)).toBe(55 * 60_000)
  expect(warnAt(0, 2, 1)).toBe(60_000)
  expect(warnAt(0, 2, 5)).toBe(60_000)
  expect(warnAt(null, 60, 5)).toBe(null)
  expect(warnAt(0, 60, 0)).toBe(null)
})

test('cold-cache cost: price by model, write rate by TTL, overrides win (A-4.4)', async () => {
  const table = parsePrices(undefined)
  expect(pricePerM('claude-opus-5-5', 300_000, table)).toBe(4)
  expect(pricePerM('Opus 5.5 (1M context)', 300_000, table)).toBe(4)
  expect(pricePerM('claude-haiku-5-5', 50_000, table)).toBe(0.1)
  expect(pricePerM('claude-haiku-5-5', 300_000, table)).toBe(0.5)
  expect(pricePerM('some-other-model', 1, table)).toBe(null)
  expect(pricePerM('claude-opus-5-5', 1, parsePrices('opus=3, junk, x=abc'))).toBe(3)
  // 300K tokens on Opus 5.5: 0.3 × $4 × 2 (1h TTL) = $2.40; × 1.25 (5m) = $1.50
  expect(Math.round(coldCostUsd(300_000, 4, 60)! * 100)).toBe(240)
  expect(Math.round(coldCostUsd(300_000, 4, 5)! * 100)).toBe(150)
  expect(coldCostUsd(null, 4, 60)).toBe(null)
  expect(usdText(2.4)).toBe('$2.40')
  expect(resolveBand({ ...base, cache: { minutesLeft: null, isCold: true, coldUsd: 2.4 } })?.lead).toBe('cache cold (est.) · next msg ≈ $2.40')
})
