// A-5.3: S-4 in miniature. The Blast Radius dialog runs from Steward's real
// tool.call hook; the engine beneath (ask, git, the Bash tool itself) is mocked.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On, answers: string[], surfaces = ['terminal']) {
  const asked: string[] = []
  const ran: string[] = []
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('session.cwd', () => ({ value: '/w/demo' }))
  // $.ui.ask raises a tool.call of AskUserQuestion; answer it as the dialog would.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!.question
    asked.push(q)
    const a = answers.shift()
    if (a === undefined) return { deny: 'The user dismissed the question' }
    return { result: { questions: e.questions, answers: { [q]: a } } as never }
  })
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const out = argv.includes('log') ? 'a1b2c3d fix checkout\n0f0f0f0 pricing\n' : argv.includes('status') ? ' M app.txt\n' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => { ran.push(e.command); return { result: { stdout: 'ok', stderr: '', interrupted: false } as never } })
  return { asked, ran, store }
}

const bash = ($: { tool: { call: (e: never) => Promise<unknown> } }, command: string) =>
  $.tool.call({ tool: 'Bash', command } as never) as Promise<{ deny?: string }>

test('S-4: preview in the dialog; Cancel blocks with a reason, Proceed runs', async ($, on) => {
  const w = world(on, ['Cancel', 'Proceed'])
  const r1 = await bash($, 'git reset --hard HEAD~2')
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]!.includes('drops 2 commits')).toBe(true)
  expect(w.asked[0]!.includes('a1b2c3d fix checkout')).toBe(true)
  expect(w.ran.length).toBe(0)
  expect(String(r1.deny).includes('the user cancelled `git reset --hard HEAD~2`')).toBe(true)
  expect(String(r1.deny).includes('Do not retry')).toBe(true)

  const r2 = await bash($, 'git reset --hard HEAD~2')
  expect(r2.deny).toBe(undefined)
  expect(w.ran).toEqual(['git reset --hard HEAD~2'])
})

test('S-4: Allow for session stops the next prompt for that exact command only', async ($, on) => {
  const w = world(on, ['Allow for session', 'Cancel'])
  await bash($, 'git reset --hard HEAD~2')
  await bash($, 'git reset --hard HEAD~2')
  expect(w.asked.length).toBe(1)
  expect(w.ran.length).toBe(2)
  const other = await bash($, 'git reset --hard HEAD~5') // a different command still asks
  expect(w.asked.length).toBe(2)
  expect(other.deny === undefined).toBe(false)
})

test('quiet commands never ask; headless fails open; dismissed counts as cancel; Other is passed on', async ($, on) => {
  const w = world(on, [])
  await bash($, 'ls -la && git status')
  expect(w.asked.length).toBe(0)
  expect(w.ran.length).toBe(1)
  const dismissed = await bash($, 'git reset --hard')
  expect(String(dismissed.deny).includes('dismissed')).toBe(true)
  expect(w.ran.length).toBe(1)
})

test('headless: no surface, so it runs without asking', async ($, on) => {
  const w = world(on, [], [])
  const r = await bash($, 'git reset --hard HEAD~1')
  expect(r.deny).toBe(undefined)
  expect(w.asked.length).toBe(0)
  expect(w.ran.length).toBe(1)
})

test('text typed under Other reaches the model as the instruction', async ($, on) => {
  const w = world(on, ['only drop the last one'])
  const r = await bash($, 'git reset --hard HEAD~2')
  expect(String(r.deny).includes('with this instruction: "only drop the last one"')).toBe(true)
  expect(w.ran.length).toBe(0)
})

const steward = async ($: { command: { run: (e: never) => Promise<unknown> } }, args: string) =>
  String(((await $.command.run({ command: 'steward', args } as never)) as { text?: string }).text)

test('A-5.4: /steward allow saves a pattern for every session; remove brings the question back', async ($, on) => {
  const w = world(on, ['Cancel'])
  expect((await steward($, 'allow rm   -rf  node_modules')).includes('Saved: rm -rf node_modules')).toBe(true)
  expect(w.store.get('blastAllow')).toEqual(['rm -rf node_modules'])
  await bash($, 'cd app && rm -rf node_modules')
  expect(w.asked.length).toBe(0)
  expect(w.ran.length).toBe(1)
  await bash($, 'rm -rf node_modules src') // more than the pattern: still asks
  expect(w.asked.length).toBe(1)

  expect((await steward($, 'allow')).includes('  rm -rf node_modules')).toBe(true)
  expect((await steward($, 'allow remove rm -rf node_modules')).includes('Removed')).toBe(true)
  expect(w.store.get('blastAllow')).toEqual([])
  await bash($, 'rm -rf node_modules')
  expect(w.asked.length).toBe(2)
})

test('A-5.4: wildcards, and patterns too broad to save', async ($, on) => {
  const w = world(on, [])
  await steward($, 'allow git push --force origin *')
  await bash($, 'git push --force origin feat')
  expect(w.asked.length).toBe(0)
  expect((await steward($, 'allow **')).startsWith('Not saved')).toBe(true)
  expect((await steward($, 'allow * -rf x')).startsWith('Not saved')).toBe(true)
  expect((await steward($, 'allow rm **')).startsWith('Not saved')).toBe(true)
  expect((await steward($, 'allow ls -la')).includes('would not have asked')).toBe(true)
  expect(w.store.get('blastAllow')).toEqual(['git push --force origin *', 'ls -la'])
})

test('A-5.5: every outcome is recorded for the Guards section; the saved list is mirrored', async ($, on) => {
  const w = world(on, ['Cancel', 'Proceed'])
  on('clock.now', () => ({ value: Date.now() }))
  await bash($, 'rm -rf build')
  await bash($, 'rm -rf build')
  await steward($, 'allow rm -rf dist')
  await bash($, 'rm -rf dist')
  await bash($, 'ls') // not destructive: not recorded
  const ui = await $.ui.mount({
    plugin: 'steward', component: 'Pane', requestId: 'steward', surface: 'terminal',
    props: { title: 'Steward', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  } as never)
  expect((await ui.find({ type: 'Text', text: /blocked ·/ }))?.text).toBe('1 blocked · 1 proceeded · 1 allowed')
  expect(((await ui.find({ type: 'Text', text: /rm -rf dist/ }))?.text ?? '').startsWith('↷ rm -rf dist')).toBe(true)
  expect(((await ui.find({ type: 'Text', text: /allow list/ }))?.text ?? '').includes('1 saved')).toBe(true)
  await ui.unmount()
  expect(w.ran).toEqual(['rm -rf build', 'rm -rf dist', 'ls'])
})
