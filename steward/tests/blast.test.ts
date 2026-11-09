// A-5.3: S-4 in miniature. The Blast Radius dialog runs from Steward's real
// tool.call hook; the engine beneath (ask, git, the Bash tool itself) is mocked.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On, answers: string[], surfaces = ['terminal']) {
  const asked: string[] = []
  const ran: string[] = []
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
  return { asked, ran }
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
