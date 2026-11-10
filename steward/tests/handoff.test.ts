// A-3.7: the handoff across /clear, run through Steward's real hooks with the
// engine mocked beneath: store (the brief survives the clear), clock (retries,
// expiry) and the prompt box (fills taken or refused).
import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionEndReason } from 'claude-code'

const BRIEF = '# Handoff brief · test\n\n## Goal\nShip A-3.7\n'
const REL = '.claude/handoffs/test.md'

/** Mocks the world: returns the clock and the fills the prompt box saw. */
function world(on: On, opts: { pendingAgeMs?: number; refuse?: number; noPending?: boolean; editing?: string } = {}) {
  const clock = mock.clock(on)
  const now = clock.now()
  // The store as a Map the test can read back (the test's $ has no store noun).
  const store = new Map<string, unknown>()
  if (opts.editing) store.set('editingBrief', { at: now, rel: opts.editing })
  if (!opts.noPending) store.set('pendingBrief', { brief: BRIEF, at: now - (opts.pendingAgeMs ?? 0), rel: REL })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  const fills: string[] = []
  let refuse = opts.refuse ?? 0
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    if (refuse > 0) { refuse--; return { isFilled: false } }
    return { isFilled: true }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: unknown }).text ?? '')); return { value: undefined } })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  return { clock, fills, toasts, pending: () => store.get('pendingBrief') }
}

const end = (reason: SessionEndReason) => ({ reason, sessionId: 's-old', resume: { id: 's-old' } })

test('a /clear puts the saved brief in the new prompt box, once', async ($, on) => {
  const w = world(on)
  await $.session.end(end('clear'))
  await w.clock.advance(700)
  expect(w.fills).toEqual([BRIEF])
  expect(w.pending()).toBe(undefined)
  expect(w.toasts.some(t => t.includes('handoff arrived'))).toBe(true)
  await w.clock.advance(5000)
  expect(w.fills.length).toBe(1)
})

test('retries while the new prompt box mounts', async ($, on) => {
  const w = world(on, { refuse: 2 })
  await $.session.end(end('clear'))
  await w.clock.advance(600 + 1000 + 1000 + 100)
  expect(w.fills.length).toBe(3)
  expect(w.pending()).toBe(undefined)
})

test('gives up after 10 tries and points at the file', async ($, on) => {
  const w = world(on, { refuse: 99 })
  await $.session.end(end('clear'))
  await w.clock.advance(600 + 9 * 1000 + 100)
  expect(w.fills.length).toBe(10)
  expect(w.pending()).toBe(undefined)
  expect(w.toasts.some(t => t.includes(REL))).toBe(true)
  await w.clock.advance(5000)
  expect(w.fills.length).toBe(10)
})

test('a stale brief (over 2 minutes) is not re-seeded', async ($, on) => {
  const w = world(on, { pendingAgeMs: 3 * 60_000 })
  await $.session.end(end('clear'))
  await w.clock.advance(700)
  expect(w.fills).toEqual([])
  expect(w.pending()).toBe(undefined)
  expect(w.toasts.some(t => t.includes('expired') && t.includes(REL))).toBe(true)
})

test('a plain /clear with nothing saved does nothing', async ($, on) => {
  const w = world(on, { noPending: true })
  await $.session.end(end('clear'))
  await w.clock.advance(3000)
  expect(w.fills).toEqual([])
})

test('a session that ends for another reason is never re-seeded', async ($, on) => {
  const w = world(on)
  await $.session.end(end('logout'))
  await w.clock.advance(3000)
  expect(w.fills).toEqual([])
  expect(w.pending()).toEqual(expect.objectContaining({ rel: REL }))
})

// A-3.3: Enter on an edited brief hands off with it, but only for the person's own Enter.
test('Enter on an edited brief (composer) hands off; the same text from elsewhere is sent as usual', async ($, on) => {
  const w = world(on, { noPending: true, editing: '.claude/handoffs/e.md' })
  const written: string[] = []
  on('session.root', () => ({ value: '/w' }))
  on('fs.write', (_, e) => { written.push(e.path); return { value: undefined } })
  on('fs.list', () => ({ value: [] as never }))
  on('fs.exists', () => ({ value: false }))
  on('command.run', () => ({ text: '' } as never))
  on('prompt.submit', (_, e) => ({ text: e.text } as never))

  const other = await $.prompt.submit({ text: BRIEF, origin: { kind: 'sdk' } } as never) as { drop?: string }
  expect(other.drop).toBe(undefined)
  expect(written.length).toBe(0)

  const mine = await $.prompt.submit({ text: BRIEF, origin: { kind: 'composer' } } as never) as { drop?: string }
  expect(String(mine.drop).includes('Handing off with your edited brief')).toBe(true)
  expect(written).toEqual(['/w/.claude/handoffs/e.md'])
  expect(w.pending()).not.toBe(undefined)
})
