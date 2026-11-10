// A-6.2 (PRD G-1): Steward's real tool.call hook records successful edits in this
// session's registry file; the file system and the tools beneath are mocked.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { beat, newEntry, parseEntry, recordEdit, serialize } from '../hooks/core/registry'

const DIR = '/home/me/.claude/steward/registry'

function world(on: On, answers: string[] = [], surfaces = ['terminal']) {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const asked: string[] = []
  const edited: string[] = []
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!.question
    asked.push(q)
    const a = answers.shift()
    return a === undefined ? { deny: 'dismissed' } : { result: { questions: e.questions, answers: { [q]: a } } as never }
  })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path!.length + 1), kind: 'file', size: 1, mtimeMs: mtimes.get(p) ?? clock.now(), isLink: false })) as never }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w/app' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const f = files.get(e.path); if (f === undefined) throw new Error('ENOENT'); return { value: f as never } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); mtimes.set(e.path, clock.now()); return { value: undefined } })
  // The tools beneath: an Edit of a missing file fails; everything else succeeds.
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit' && e.file_path.endsWith('missing.ts')) return { result: 'File does not exist' as never, isError: true }
    if (e.tool === 'Edit' || e.tool === 'Write') edited.push(e.file_path)
    return { result: {} as never }
  })
  const mine = () => parseEntry(files.get(`${DIR}/self.json`) ?? '')
  /** Another live session that edited `file` `minsAgo` minutes ago. */
  const other = (id: string, file: string, minsAgo: number, task = 'change Pro price $29 → $39') => {
    const now = clock.now()
    // The edit happened minsAgo; the heartbeat is now (recordEdit alone would date it to the edit).
    const e = beat(recordEdit(newEntry(id, '/w', '/w', now), file, now - minsAgo * 60_000, 60 * 60_000), now, { status: 'working', task })
    files.set(`${DIR}/${id}.json`, serialize(e))
    mtimes.set(`${DIR}/${id}.json`, now)
  }
  return { clock, files, mine, asked, edited, other }
}

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', replace_all: false }) as never

test('A-6.2: Edit, Write and NotebookEdit are recorded; relative paths made absolute', async ($, on) => {
  const w = world(on)
  await $.tool.call(edit('/w/app/src/a.ts'))
  await w.clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: 'src/../lib/b.ts', content: 'x' } as never)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/w/app/n.ipynb', new_source: 'x' } as never)
  await $.tool.call(edit('/w/app/src/a.ts')) // again: moves to newest, not duplicated
  expect(w.mine()!.edits.map(x => x.file)).toEqual(['/w/app/lib/b.ts', '/w/app/n.ipynb', '/w/app/src/a.ts'])
  expect(w.mine()!.root).toBe('/w')
})

test('A-6.2: failed or refused edits and other tools are not recorded', async ($, on) => {
  const w = world(on)
  await $.tool.call(edit('/w/app/missing.ts'))
  await $.tool.call({ tool: 'Read', file_path: '/w/app/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'echo hi > /w/app/c.ts' } as never)
  expect(w.mine()).toBe(null)
  await $.tool.call(edit('/w/app/ok.ts'))
  expect(w.mine()!.edits.map(x => x.file)).toEqual(['/w/app/ok.ts'])
})

test('A-6.2: edits older than the window drop off the file', async ($, on) => {
  const w = world(on)
  await $.tool.call(edit('/w/app/old.ts'))
  await w.clock.advance(31 * 60_000)
  await $.tool.call(edit('/w/app/new.ts'))
  expect(w.mine()!.edits.map(x => x.file)).toEqual(['/w/app/new.ts'])
})

// ── A-6.3 / A-6.4: the pre-edit check ──
test('alone, or nobody touched the file: no question (G-7)', async ($, on) => {
  const w = world(on)
  await $.tool.call(edit('/w/app/a.ts'))
  w.other('b', '/w/app/elsewhere.ts', 1)
  await $.tool.call(edit('/w/app/a.ts'))
  expect(w.asked.length).toBe(0)
  expect(w.edited.length).toBe(2)
})

test('S-1 in miniature: names file, age and task; Cancel blocks with a reason; Proceed asks once', async ($, on) => {
  const w = world(on, ['Cancel', 'Proceed'])
  w.other('b', '/w/app/pricing.html', 3)
  const r1 = await $.tool.call(edit('/w/app/pricing.html')) as { deny?: string }
  expect(w.asked[0]).toBe('app/pricing.html was edited 3 min ago by another session ("change Pro price $29 → $39", working). Editing it here may overwrite that work. How should I proceed?')
  expect(w.edited.length).toBe(0)
  expect(String(r1.deny).includes('the user cancelled this edit')).toBe(true)
  expect(String(r1.deny).includes('Do not retry')).toBe(true)

  await $.tool.call(edit('/w/app/pricing.html'))
  expect(w.edited.length).toBe(1)
  await $.tool.call(edit('/w/app/pricing.html')) // acknowledged: no second question
  expect(w.asked.length).toBe(2)
  expect(w.edited.length).toBe(2)

  await w.clock.advance(1000)
  w.other('b', '/w/app/pricing.html', 0) // the other session edits it again: ask again
  await $.tool.call(edit('/w/app/pricing.html'))
  expect(w.asked.length).toBe(3)
})

test('worktree and Other reach the model; dismissed counts as cancel', async ($, on) => {
  const w = world(on, ['Move to worktree', 'use a green badge instead'])
  w.other('b', '/w/app/p.html', 1)
  const wt = await $.tool.call({ tool: 'Write', file_path: '/w/app/p.html', content: 'x' } as never) as { deny?: string }
  expect(String(wt.deny).includes('Call EnterWorktree first, then make this edit again there')).toBe(true)
  const other = await $.tool.call(edit('/w/app/p.html')) as { deny?: string }
  expect(String(other.deny).includes('with an instruction: "use a green badge instead"')).toBe(true)
  const dismissed = await $.tool.call(edit('/w/app/p.html')) as { deny?: string }
  expect(String(dismissed.deny).includes('the user cancelled')).toBe(true)
  expect(w.edited.length).toBe(0)
})

test('outside the window, stale or ended sessions: no question', async ($, on) => {
  const w = world(on)
  w.other('b', '/w/app/p.html', 31)
  await $.tool.call(edit('/w/app/p.html'))
  expect(w.asked.length).toBe(0)
  w.other('c', '/w/app/p.html', 1)
  await w.clock.advance(3 * 60_000) // c's heartbeat goes stale
  await $.tool.call(edit('/w/app/p.html'))
  expect(w.asked.length).toBe(0)
  expect(w.edited.length).toBe(2)
})

test('headless: fails open without asking (G-8)', async ($, on) => {
  const w = world(on, [], [])
  w.other('b', '/w/app/p.html', 1)
  const r = await $.tool.call(edit('/w/app/p.html')) as { deny?: string }
  expect(r.deny).toBe(undefined)
  expect(w.asked.length).toBe(0)
  expect(w.edited.length).toBe(1)
})

// ── A-6.5: the heartbeat ──
test('heartbeat: every 30 s from session start; prompt sets the task; turns set the status; end says ended', async ($, on) => {
  const w = world(on)
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('session.usage', () => ({ value: { context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0 } } as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', () => ({ value: { command: 'steward' } as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.panes', () => ({ value: [] as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd } as never))
  on('prompt.submit', (_, e) => ({ text: e.text } as never))
  on('turn.start', () => ({} as never))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/w/app', surface: 'terminal', isInteractive: true } as never)
  const first = w.mine()!.heartbeatAt
  expect(w.mine()!.status).toBe('idle')
  await w.clock.advance(30_000)
  expect(w.mine()!.heartbeatAt).toBe(first + 30_000)

  await $.prompt.submit({ text: '  fix the\n pricing page header  ' } as never)
  expect(w.mine()!.task).toBe('fix the pricing page header')
  expect(w.mine()!.status).toBe('working')
  await $.prompt.submit({ text: '/steward status' } as never) // a slash command is not a task
  expect(w.mine()!.task).toBe('fix the pricing page header')

  await $.session.end({ reason: 'other', sessionId: 'self', resume: false } as never)
  expect(w.mine()!.status).toBe('ended')
  const endedAt = w.mine()!.heartbeatAt
  await w.clock.advance(90_000) // stopped: no more beats
  expect(w.mine()!.heartbeatAt).toBe(endedAt)
})

test('heartbeat keeps an idle session live for the other session\'s check (S-1 shape)', async ($, on) => {
  const w = world(on, ['Cancel'])
  w.other('b', '/w/app/p.html', 1)
  await w.clock.advance(5 * 60_000)
  w.other('b', '/w/app/p.html', 6) // b only beat (its edit is 6 min old): still live, still a hit
  const r = await $.tool.call(edit('/w/app/p.html')) as { deny?: string }
  expect(w.asked[0]!.startsWith('app/p.html was edited 6 min ago')).toBe(true)
  expect(r.deny === undefined).toBe(false)
})
