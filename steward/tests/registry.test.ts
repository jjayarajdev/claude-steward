// A-6.1: registry merge, expiry and the on-disk round trip.
import { expect, test } from 'claude-code/testing'

import { STALE_MS, beat, liveOthers, newEntry, normPath, parseEntry, recordEdit, sameRoot, serialize, touchedBy, trimTask } from '../hooks/core/registry'

const MIN = 60_000
const WIN = 30 * MIN
const T0 = 1_800_000_000_000

test('recordEdit: one entry per file, newest last, old edits drop', async () => {
  let e = newEntry('a', '/w', '/w', T0)
  e = recordEdit(e, '/w/x.ts', T0, WIN)
  e = recordEdit(e, '/w/y.ts', T0 + MIN, WIN)
  e = recordEdit(e, '/w/x.ts', T0 + 2 * MIN, WIN)
  expect(e.edits).toEqual([{ file: '/w/y.ts', at: T0 + MIN }, { file: '/w/x.ts', at: T0 + 2 * MIN }])
  e = recordEdit(e, '/w/z.ts', T0 + 32 * MIN, WIN) // y is now 31 min old
  expect(e.edits.map(x => x.file)).toEqual(['/w/x.ts', '/w/z.ts'])
  expect(e.heartbeatAt).toBe(T0 + 32 * MIN)
})

test('merge: self, stale, ended and malformed are left out; duplicates keep the newest', async () => {
  const live = (id: string, at: number, root = '/w') => beat(newEntry(id, root, root, at), at, { status: 'working' })
  const entries = [
    live('self', T0),
    live('b', T0 - STALE_MS + 1000),
    live('c', T0 - STALE_MS - 1000), // stale
    beat(live('d', T0), T0, { status: 'ended' }),
    live('e', T0 - 10_000, '/other'),
    live('e', T0 - 5_000, '/other'),
    null,
  ]
  const o = liveOthers(entries, 'self', T0)
  expect(o.map(x => x.sessionId)).toEqual(['e', 'b'])
  expect(o[0]!.heartbeatAt).toBe(T0 - 5_000)
  expect(sameRoot(o, '/w').map(x => x.sessionId)).toEqual(['b'])
})

test('touchedBy: only edits inside the window, most recent first', async () => {
  const b = recordEdit(beat(newEntry('b', '/w', '/w', T0), T0, { task: 'change Pro price $29 → $39' }), '/w/p.html', T0 - 5 * MIN, WIN)
  const c = recordEdit(newEntry('c', '/w', '/w', T0), '/w/p.html', T0 - 2 * MIN, WIN)
  const d = recordEdit(newEntry('d', '/w', '/w', T0), '/w/p.html', T0 - 40 * MIN, WIN * 2)
  const t = touchedBy([b, c, d], '/w/p.html', T0, WIN)
  expect(t.map(x => x.sessionId)).toEqual(['c', 'b'])
  expect(t[1]!.task).toBe('change Pro price $29 → $39')
  expect(touchedBy([b], '/w/other.html', T0, WIN)).toEqual([])
})

test('parse: round trip, and anything malformed is null', async () => {
  const e = recordEdit(newEntry('a', '/w', '/w/sub', T0), '/w/x', T0, WIN)
  expect(parseEntry(serialize(e))).toEqual(e)
  expect(parseEntry('{"v":1,"sessionId":"a","root":"/w","heartbeatAt":')).toBe(null) // half-written
  expect(parseEntry('{"v":2,"sessionId":"a","root":"/w","heartbeatAt":1}')).toBe(null)
  expect(parseEntry('[]')).toBe(null)
  const loose = parseEntry('{"v":1,"sessionId":"a","root":"/w","heartbeatAt":5,"status":"??","edits":[{"file":"/x","at":1},{"file":3}]}')
  expect(loose!.status).toBe('idle')
  expect(loose!.edits).toEqual([{ file: '/x', at: 1 }])
})

test('paths and task text', async () => {
  expect(normPath('/w/app', 'src/../lib/./a.ts')).toBe('/w/app/lib/a.ts')
  expect(normPath('/w/app', '/abs//x/')).toBe('/abs/x')
  expect(trimTask('  fix\n the   pricing page  ')).toBe('fix the pricing page')
  expect(trimTask('x'.repeat(100)).length).toBe(80)
})

// The on-disk round trip (noteEdit / heartbeat / readOthers) is tested through
// Steward's real Edit hook in A-6.2: a test's own hooks may not call $ for a module.
