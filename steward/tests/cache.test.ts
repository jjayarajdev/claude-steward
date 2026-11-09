// A-4.7: the cache countdown, the lead-time warning (S-5 in miniature) and
// keep-warm, run through Steward's real hooks with the engine mocked beneath.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }

function world(on: On, ttlMinutes = 2) {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>([['ttlMinutes', ttlMinutes]])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('session.usage', () => ({ value: { context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [], cost: { usd: 1 } } as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.complete', () => ({ text: 'done', usage: USAGE }))
  const notes: string[] = []
  on('ui.notify', (_, e) => { notes.push(String((e as { text?: unknown }).text ?? '')); return { value: { isSent: true } as never } })
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: unknown }).text ?? '')); return { value: undefined } })
  const forks: string[] = []
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 } } as never }
  })
  return { clock, notes, toasts, forks, store }
}

/** session.start isn't raised in these tests, so set the window the way a person does. */
const setTtl = async ($: { command: { run: (e: never) => Promise<unknown> } }, min: number) =>
  $.command.run({ command: 'steward', args: `ttl ${min}` } as never)

const turnEnd = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }

test('S-5: warn at the lead, once; a new reply re-arms it', async ($, on) => {
  const w = world(on, 2) // lead 5 is capped at half the window: warn at 1 min
  await setTtl($, 2)
  await $.turn.complete(turnEnd)
  await w.clock.advance(59_000)
  expect(w.notes.length).toBe(0)
  await w.clock.advance(2_000)
  expect(w.notes.length).toBe(1)
  expect(w.notes[0]!.includes('Cache cold in 1m (est.)')).toBe(true)
  await w.clock.advance(5 * 60_000) // cold now: no second warning
  expect(w.notes.length).toBe(1)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  await w.clock.advance(61_000)
  expect(w.notes.length).toBe(2)
})

test('a reply just before the warning cancels it', async ($, on) => {
  const w = world(on, 2)
  await setTtl($, 2)
  await $.turn.complete(turnEnd)
  await w.clock.advance(50_000)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  await w.clock.advance(50_000) // 100 s after the first reply, 50 s after the second
  expect(w.notes.length).toBe(0)
  await w.clock.advance(11_000)
  expect(w.notes.length).toBe(1)
})

test('keep warm: refused before any reply, pings once after, refused when cold', async ($, on) => {
  const w = world(on, 2)
  await setTtl($, 2)
  const before = await $.command.run({ command: 'steward', args: 'ping' } as never) as { text?: string }
  expect(String(before.text).includes('Nothing to keep warm')).toBe(true)
  expect(w.forks.length).toBe(0)

  await $.turn.complete(turnEnd)
  await w.clock.advance(30_000)
  await $.command.run({ command: 'steward', args: 'ping' } as never)
  await w.clock.advance(100)
  expect(w.forks.length).toBe(1)
  expect(w.toasts.some(t => t.includes('cache kept warm (300K read'))).toBe(true)

  // The ping restarted the window: 1 min 50 s later it is still warm, no warning yet at 1 min 10 s.
  await w.clock.advance(50_000)
  expect(w.notes.length).toBe(0)

  await w.clock.advance(3 * 60_000)
  const cold = await $.command.run({ command: 'steward', args: 'ping' } as never) as { text?: string }
  expect(String(cold.text).includes('already cold')).toBe(true)
  expect(w.forks.length).toBe(1)
})

test('/steward ttl saves the window for every session', async ($, on) => {
  const w = world(on, 60)
  const r = await $.command.run({ command: 'steward', args: 'ttl 5' } as never) as { text?: string }
  expect(String(r.text).includes('set to 5 min')).toBe(true)
  expect(w.store.get('ttlMinutes')).toBe(5)
  const bad = await $.command.run({ command: 'steward', args: 'ttl 0' } as never) as { text?: string }
  expect(String(bad.text).includes('not a whole number')).toBe(true)
  expect(w.store.get('ttlMinutes')).toBe(5)
})
