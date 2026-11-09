// A-5.1 (PRD B-1): tokenizer and destructive-command matcher, positive and negative.
import { expect, test } from 'claude-code/testing'

import { commands, findDestructive, matchesPattern, parsePatterns, tokenize } from '../hooks/core/shell'
import { commitLines, findDryRun, fmtBytes, globToRegExp, nameList, resolvePath } from '../hooks/core/impact'

const kinds = (line: string, user: string[] = []) => findDestructive(line, user).map(h => h.kind)

test('tokenizer: quotes, escapes, operators, comments, redirections', async () => {
  expect(tokenize(`rm -rf "my dir" 'a b' c\\ d`)).toEqual(['rm', '-rf', 'my dir', 'a b', 'c d'])
  expect(tokenize('echo "x;y" ; ls')).toEqual(['echo', 'x;y', ';', 'ls'])
  expect(tokenize('a && b || c | d & e')).toEqual(['a', '&&', 'b', '||', 'c', '|', 'd', '&', 'e'])
  expect(tokenize('ls # rm -rf /')).toEqual(['ls'])
  expect(tokenize('cat a > out.txt')).toEqual(['cat', 'a', 'out.txt'])
  expect(tokenize(`echo ""`)).toEqual(['echo', ''])
  expect(commands('cd x && rm -rf build; echo $(rm -r tmp)')).toEqual([['cd', 'x'], ['rm', '-rf', 'build'], ['echo'], ['rm', '-r', 'tmp']])
})

// ── positives: every one of these must ask ──
const POSITIVE: [string, string][] = [
  ['rm -rf build/', 'rm'],
  ['rm -r src', 'rm'],
  ['rm -R src', 'rm'],
  ['rm --recursive --force dist', 'rm'],
  ['rm -fr ./out', 'rm'],
  ['rm *.log', 'rm'],
  ['/bin/rm -rf x', 'rm'],
  ['sudo rm -rf /var/tmp/x', 'rm'],
  ['FOO=1 env BAR=2 rm -rf x', 'rm'],
  ['cd app && rm -rf node_modules && npm i', 'rm'],
  [`bash -c 'rm -rf build'`, 'rm'],
  ['echo $(rm -rf tmp)', 'rm'],
  ['echo `rm -rf tmp`', 'rm'],
  ['find . -name "*.tmp" | xargs rm', 'rm'],
  ['git push --force', 'git-push-force'],
  ['git push -f origin main', 'git-push-force'],
  ['git push --force-with-lease origin feat', 'git-push-force'],
  ['git push origin +main', 'git-push-force'],
  ['git push origin --delete old', 'git-push-force'],
  ['git reset --hard HEAD~2', 'git-reset-hard'],
  ['git -C repo reset --hard', 'git-reset-hard'],
  ['git clean -fd', 'git-clean'],
  ['git clean -f', 'git-clean'],
  ['git checkout -- .', 'git-discard'],
  ['git checkout -- src/a.ts', 'git-discard'],
  ['git checkout .', 'git-discard'],
  ['git restore .', 'git-discard'],
  ['git restore src/a.ts', 'git-discard'],
  ['git branch -D feature', 'git-branch-delete'],
  ['git branch --delete --force feature', 'git-branch-delete'],
  ['git stash drop', 'git-discard'],
  ['find . -name "*.pyc" -delete', 'find-delete'],
  ['find build -type f -exec rm {} \\;', 'find-delete'],
]

for (const [line, kind] of POSITIVE) {
  test(`asks: ${line}`, async () => {
    expect(kinds(line)).toContain(kind)
  })
}

// ── negatives: none of these may ask ──
const NEGATIVE = [
  'rm file.txt',
  'rm -f file.txt',
  'rm -i a b',
  'echo "rm -rf /"',
  `grep -r "rm -rf" .`,
  'ls -la && cat README.md',
  'git push',
  'git push -u origin feat',
  'git reset HEAD~1',
  'git reset --soft HEAD~1',
  'git clean -n',
  'git clean -nfd',
  'git checkout main',
  'git checkout -b new-branch',
  'git restore --staged src/a.ts',
  'git branch -d merged',
  'git status # git reset --hard',
  'find . -name "*.ts"',
  'npm run clean',
  'mkdir -p build && cp -r src build',
]

for (const line of NEGATIVE) {
  test(`quiet: ${line}`, async () => {
    expect(kinds(line)).toEqual([])
  })
}

test('targets and labels for the dialog', async () => {
  const [rm] = findDestructive('sudo rm -rf build/ dist')
  expect(rm!.targets).toEqual(['build/', 'dist'])
  expect(rm!.label).toBe('rm -rf build/ dist')
  expect(findDestructive('git reset --hard')[0]!.targets).toEqual(['HEAD'])
  expect(findDestructive('git checkout -- a.ts b.ts')[0]!.targets).toEqual(['a.ts', 'b.ts'])
  expect(findDestructive('ls; rm -r a; git clean -fd').map(h => h.kind)).toEqual(['rm', 'git-clean'])
})

test('user patterns (prefix) and allow patterns (whole command)', async () => {
  const user = parsePatterns('kubectl delete; terraform destroy;  ; docker system prune')
  expect(user).toEqual(['kubectl delete', 'terraform destroy', 'docker system prune'])
  expect(kinds('kubectl delete pod web-1', user)).toEqual(['user'])
  expect(kinds('kubectl get pods', user)).toEqual([])
  expect(findDestructive('terraform destroy -auto-approve', user)[0]!.pattern).toBe('terraform destroy')
  expect(matchesPattern(['rm', '-rf', 'node_modules'], 'rm -rf node_modules', false)).toBe(true)
  expect(matchesPattern(['rm', '-rf', 'node_modules', 'src'], 'rm -rf node_modules', false)).toBe(false)
  expect(matchesPattern(['/bin/rm', '-rf', 'dist'], 'rm -rf *', false)).toBe(true)
  expect(matchesPattern(['git', 'push', '--force', 'origin', 'feat'], 'git push --force **', false)).toBe(true)
})

test('a cd earlier on the line moves where the targets are', async () => {
  expect(findDestructive('cd app && rm -rf node_modules')[0]!.cd).toBe('app')
  expect(findDestructive('cd app && cd web && rm -rf dist')[0]!.cd).toBe('app/web')
  expect(findDestructive('cd /tmp; rm -rf x')[0]!.cd).toBe('/tmp')
  expect(findDestructive('rm -rf x')[0]!.cd).toBe(undefined)
})

// ── impact preview helpers (A-5.2) ──
test('impact: globs, sizes, lists, paths, commits, harmless find', async () => {
  expect(globToRegExp('*.log').test('a.log')).toBe(true)
  expect(globToRegExp('*.log').test('a.log.gz')).toBe(false)
  expect(globToRegExp('a?c').test('abc')).toBe(true)
  expect(globToRegExp('[!x]*').test('yes')).toBe(true)
  expect(globToRegExp('[!x]*').test('xno')).toBe(false)
  expect(globToRegExp('a.b(1)').test('a.b(1)')).toBe(true)
  expect(fmtBytes(512)).toBe('512 B')
  expect(fmtBytes(38 * 1024 * 1024)).toBe('38 MB')
  expect(fmtBytes(1536)).toBe('1.5 KB')
  expect(nameList([{ name: 'build/app.js' }, { name: 'build/assets', count: 201 }])).toBe('build/app.js · build/assets/ (201)')
  expect(nameList([1, 2, 3, 4, 5, 6, 7].map(n => ({ name: `f${n}` })), 5)).toBe('f1 · f2 · f3 · f4 · f5 … (+2 more)')
  expect(resolvePath('/w/app', '/home/me', 'build/')).toBe('/w/app/build')
  expect(resolvePath('/w/app', '/home/me', './build')).toBe('/w/app/build')
  expect(resolvePath('/w/app', '/home/me', '~/tmp')).toBe('/home/me/tmp')
  expect(resolvePath('/w/app', '/home/me', '/var/x/')).toBe('/var/x')
  expect(commitLines('a1 one\nb2 two\n').count).toBe(2)
  expect(findDryRun(['find', '.', '-name', '*.pyc', '-delete'])).toEqual(['find', '.', '-name', '*.pyc', '-print'])
  expect(findDryRun(['find', 'b', '-type', 'f', '-exec', 'rm', '{}', ';'])).toEqual(['find', 'b', '-type', 'f', '-print'])
})
