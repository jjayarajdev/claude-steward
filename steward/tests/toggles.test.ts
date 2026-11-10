// A-7.2 (D-1): each feature switched off hides its pane section and its hooks do nothing.
// The engine beneath is mocked; Steward's settings come from the test's options.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { beat, newEntry, recordEdit, serialize } from '../hooks/core/registry'

const DIR = '/home/me/.claude/steward/registry'
const ALL_ON = { context: 'on', cache: 'on', usage: 'on', collision: 'on', blast: 'on' }

function world(on: On, surfaces: string[] = ['terminal']) {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const store = new Map<string, unknown>([['ttlMinutes', 2]])
  const asked: string[] = []
  const ran: string[] = []
  const notes: string[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => { statuses.push((e as { text?: string }).text); return { value: undefined } })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], cost: { usd: 1 } } as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd } as never))
  on('command.register', () => ({ value: { command: 'steward' } as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.panes', () => ({ value: [] as never }))
  on('ui.notify', (_, e) => { notes.push(String((e as { text?: unknown }).text)); return { value: { isSent: true } as never } })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const f = files.get(e.path); if (f === undefined) throw new Error('ENOENT'); return { value: f as never } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path!.length + 1), kind: 'file', size: 1, mtimeMs: clock.now(), isLink: false })) as never }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } as never }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } as never }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    asked.push(e.questions[0]!.question)
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } } as never }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    if (e.tool === 'Edit') ran.push(`edit ${e.file_path}`)
    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  on('turn.complete', () => ({ text: 'done', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 } } as never))
  // Another live session that edited /w/p.html a minute ago.
  const now = clock.now()
  files.set(`${DIR}/b.json`, serialize(beat(recordEdit(newEntry('b', '/w', '/w', now), '/w/p.html', now - 60_000, 30 * 60_000), now, { status: 'working', task: 'pricing' })))
  return { clock, files, asked, ran, notes, statuses }
}

const PANE = { plugin: 'steward', component: 'Pane', requestId: 'steward', surface: 'terminal',
  props: { title: 'Steward', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} } } as never
const start = { cwd: '/w', surface: 'terminal', isInteractive: true } as never
const edit = { tool: 'Edit', file_path: '/w/p.html', old_string: 'a', new_string: 'b', replace_all: false } as never
const turnEnd = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never

async function sections($: { ui: { mount: (t: never) => Promise<{ find: (q: never) => Promise<unknown>; unmount: () => Promise<void> }> } }): Promise<string[]> {
  const ui = await $.ui.mount(PANE)
  const out: string[] = []
  for (const id of ['context', 'cache', 'usage', 'sessions', 'guards', 'handoffs', 'commands']) {
    if (await ui.find({ key: `sec-${id}` } as never)) out.push(id)
  }
  await ui.unmount()
  return out
}

test('all on: every section shows; both guards ask', { options: ALL_ON }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  expect(await sections($)).toEqual(['context', 'cache', 'usage', 'sessions', 'guards', 'handoffs', 'commands'])
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  await $.tool.call(edit)
  expect(w.asked.length).toBe(2)
  expect(w.ran.length).toBe(0)
  expect(w.files.has(`${DIR}/self.json`)).toBe(true) // heartbeat
})

test('blast off: destructive commands run without a question', { options: { ...ALL_ON, blast: 'off' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  expect(w.asked.length).toBe(0)
  expect(w.ran).toEqual(['rm -rf build'])
  expect((await sections($)).includes('guards')).toBe(true) // collision still guards
})

test('collision off: no question, no registry file, no sessions section', { options: { ...ALL_ON, collision: 'off' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call(edit)
  await w.clock.advance(60_000)
  expect(w.asked.length).toBe(0)
  expect(w.ran).toEqual(['edit /w/p.html'])
  expect(w.files.has(`${DIR}/self.json`)).toBe(false)
  expect((await sections($)).includes('sessions')).toBe(false)
})

test('both guards off: no guards section', { options: { ...ALL_ON, collision: 'off', blast: 'off' } }, async ($, on) => {
  world(on)
  await $.session.start(start)
  expect((await sections($)).includes('guards')).toBe(false)
})

test('cache off: no countdown warning, no cache section', { options: { ...ALL_ON, cache: 'off' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await w.clock.advance(3 * 60_000)
  expect(w.notes.length).toBe(0)
  expect((await sections($)).includes('cache')).toBe(false)
})

test('cache on (control): the same run warns', { options: ALL_ON }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await w.clock.advance(3 * 60_000)
  expect(w.notes.length).toBe(1)
})

test('context and usage off: their sections hide', { options: { ...ALL_ON, context: 'off', usage: 'off' } }, async ($, on) => {
  world(on)
  await $.session.start(start)
  expect(await sections($)).toEqual(['cache', 'sessions', 'guards', 'handoffs', 'commands'])
})

// ── A-7.3: VS Code and mobile draw no band; the status line carries it ──
test('VS Code, pane not shown: the band goes to the status line, and only on change', { options: ALL_ON }, async ($, on) => {
  const w = world(on, ['vscode'])
  await $.session.start(start)
  await w.clock.advance(5_000)
  expect(w.statuses.length).toBe(1)
  expect(String(w.statuses[0]).includes('ctx 25%')).toBe(true)
  await w.clock.advance(10_000) // nothing changed: no rewrite
  expect(w.statuses.length).toBe(1)
})

test('terminal: the band is drawn there, so the status line stays empty', { options: ALL_ON }, async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.start(start)
  await w.clock.advance(15_000)
  expect(w.statuses.filter(x => x !== undefined).length).toBe(0)
})
