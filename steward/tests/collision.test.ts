// A-6.2 (PRD G-1): Steward's real tool.call hook records successful edits in this
// session's registry file; the file system and the tools beneath are mocked.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseEntry } from '../hooks/core/registry'

const DIR = '/home/me/.claude/steward/registry'

function world(on: On) {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w/app' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const f = files.get(e.path); if (f === undefined) throw new Error('ENOENT'); return { value: f as never } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  // The tools beneath: an Edit of a missing file fails; everything else succeeds.
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit' && e.file_path.endsWith('missing.ts')) return { result: 'File does not exist' as never, isError: true }
    return { result: {} as never }
  })
  const mine = () => parseEntry(files.get(`${DIR}/self.json`) ?? '')
  return { clock, files, mine }
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
