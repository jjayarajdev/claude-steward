// A-5.2 (PRD B-3) impact preview: what a destructive command would actually touch,
// read with $.fs and read-only git (`log`, `status`, `diff --stat`, `clean -n`,
// `find` without -delete). Nothing here changes anything. Every step is bounded:
// a walk stops at WALK_CAP entries, each git call times out, and a failure says
// "could not preview" rather than block the dialog.
import type { EngineInterface } from 'claude-code'

import { commitLines, findDryRun, fmtBytes, globToRegExp, hasGlob, nameList, plural, resolvePath } from './core/impact'
import type { Impact } from './core/impact'
import { findDestructive, matchesPattern } from './core/shell'
import { allowForSession, noteGuard, readAllowed } from './state'
import type { Hit } from './core/shell'

const WALK_CAP = 5000
const GIT_MS = 4000

let home: string | null | undefined
async function homeDir($: EngineInterface): Promise<string | null> {
  if (home !== undefined) return home
  try {
    const r = await $.process.run(['printenv', 'HOME'], { timeoutMs: 2000 })
    home = r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch { home = null }
  return home
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_MS })
    return r.exitCode === 0 ? r.stdout : null
  } catch { return null }
}

// ── rm ──
type Tally = { files: number; dirs: number; bytes: number; capped: boolean }

async function walk($: EngineInterface, dir: string, t: Tally): Promise<void> {
  if (t.files + t.dirs >= WALK_CAP) { t.capped = true; return }
  let entries
  try { entries = await $.fs.list(dir) } catch { return }
  for (const e of entries) {
    if (t.files + t.dirs >= WALK_CAP) { t.capped = true; return }
    if (e.kind === 'dir' && !e.isLink) { t.dirs++; await walk($, `${dir}/${e.name}`, t) }
    else { t.files++; t.bytes += e.size }
  }
}

/** A target word → the real paths it names (one glob level, in its last segment). */
async function expand($: EngineInterface, abs: string): Promise<string[]> {
  if (!hasGlob(abs)) return (await $.fs.exists(abs)) ? [abs] : []
  const cut = abs.lastIndexOf('/')
  const dir = abs.slice(0, cut) || '/', seg = abs.slice(cut + 1)
  if (hasGlob(dir)) return [] // a glob in a parent folder: not expanded, said so below
  const re = globToRegExp(seg)
  try {
    return (await $.fs.list(dir)).filter(e => re.test(e.name) && (seg.startsWith('.') || !e.name.startsWith('.'))).map(e => `${dir}/${e.name}`)
  } catch { return [] }
}

async function rmImpact($: EngineInterface, h: Hit, cwd: string): Promise<Impact> {
  if (h.targets[0] === '(paths from input)') return { summary: 'deletes paths that come from the previous command (xargs), not known in advance', lines: [] }
  const hm = await homeDir($)
  const t: Tally = { files: 0, dirs: 0, bytes: 0, capped: false }
  const items: { name: string; count?: number }[] = []
  const missing: string[] = []
  for (const word of h.targets) {
    const paths = await expand($, resolvePath(cwd, hm, word))
    if (!paths.length) { missing.push(word); continue }
    for (const p of paths) {
      const shown = p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p
      let st
      try { st = await $.fs.stat(p) } catch { missing.push(word); continue }
      if (st.kind === 'dir' && !st.isLink) {
        const sub: Tally = { files: 0, dirs: 0, bytes: 0, capped: false }
        await walk($, p, sub)
        t.files += sub.files; t.dirs += sub.dirs + 1; t.bytes += sub.bytes; t.capped ||= sub.capped
        items.push({ name: shown, count: sub.files })
      } else { t.files++; t.bytes += st.size; items.push({ name: shown }) }
    }
  }
  if (!items.length) return { summary: `nothing there to delete (${missing.join(', ')} not found)`, lines: [] }
  const lines = [nameList(items)]
  if (missing.length) lines.push(`not found: ${missing.join(', ')}`)
  if (h.cd) lines.push(`in ${h.cd}/ (from the cd before it)`)
  return { summary: `deletes ${t.capped ? `${WALK_CAP}+ entries` : plural(t.files, 'file')}${t.dirs ? ` in ${plural(t.dirs, 'folder')}` : ''}, ${fmtBytes(t.bytes)}${t.capped ? '+' : ''}`, lines }
}

// ── git ──
const gitArgsAfterSub = (argv: string[]): { pre: string[]; sub: string; rest: string[] } => {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) i += argv[i] === '-C' || argv[i] === '-c' ? 2 : 1
  return { pre: argv.slice(1, i), sub: argv[i] ?? '', rest: argv.slice(i + 1) }
}

async function changedFiles($: EngineInterface, cwd: string, pre: string[]): Promise<string[]> {
  const s = await git($, cwd, [...pre, 'status', '--porcelain', '--untracked-files=no'])
  return (s ?? '').split('\n').filter(Boolean).map(l => l.slice(3))
}

async function gitImpact($: EngineInterface, h: Hit, cwd: string): Promise<Impact> {
  const { pre, sub, rest } = gitArgsAfterSub(h.argv)
  if (h.kind === 'git-reset-hard') {
    const target = h.targets[0] ?? 'HEAD'
    const log = await git($, cwd, [...pre, 'log', '--oneline', `${target}..HEAD`])
    const files = await changedFiles($, cwd, pre)
    const c = commitLines(log ?? '')
    const parts = [c.count ? `drops ${plural(c.count, 'commit')} from this branch` : null, files.length ? `discards uncommitted changes in ${plural(files.length, 'file')}` : null].filter(Boolean)
    return { summary: parts.length ? parts.join(' and ') : `moves to ${target}; no commits or uncommitted changes lost`, lines: [...c.lines, ...(files.length ? [nameList(files.map(name => ({ name })))] : [])] }
  }
  if (h.kind === 'git-push-force') {
    if (rest.includes('--delete') || rest.includes('-d') || rest.some(r => r.startsWith(':'))) {
      return { summary: `deletes branch ${rest.filter(r => !r.startsWith('-')).slice(1).join(', ').replace(/^:/, '') || '(see command)'} on the remote`, lines: [] }
    }
    const words = rest.filter(r => !r.startsWith('-'))
    let remoteRef: string | null = null
    if (words.length >= 2) remoteRef = `${words[0]}/${words[1]!.replace(/^\+/, '').split(':').pop()}`
    else remoteRef = (await git($, cwd, [...pre, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim() || null
    if (!remoteRef) return { summary: 'force-pushes; no upstream found to compare with', lines: [] }
    const log = await git($, cwd, [...pre, 'log', '--oneline', `HEAD..${remoteRef}`])
    if (log === null) return { summary: `overwrites ${remoteRef} (could not compare: not fetched?)`, lines: [] }
    const c = commitLines(log)
    return { summary: c.count ? `overwrites ${remoteRef}: ${plural(c.count, 'remote commit')} not in your branch would be lost (as of last fetch)` : `overwrites ${remoteRef}; no remote commits lost (as of last fetch)`, lines: c.lines }
  }
  if (h.kind === 'git-clean') {
    const dry = await git($, cwd, [...pre, 'clean', ...rest, '-n'])
    const files = (dry ?? '').split('\n').filter(Boolean).map(l => ({ name: l.replace(/^Would remove /, '') }))
    return { summary: dry === null ? 'could not preview (git clean -n failed)' : files.length ? `deletes ${plural(files.length, 'untracked file or folder', 'untracked files or folders')}` : 'nothing untracked to delete', lines: files.length ? [nameList(files)] : [] }
  }
  if (h.kind === 'git-discard') {
    if (sub === 'stash') {
      const top = await git($, cwd, [...pre, 'stash', 'list', '-n', rest[0] === 'clear' ? '20' : '1'])
      const n = (top ?? '').split('\n').filter(Boolean)
      return { summary: rest[0] === 'clear' ? `deletes all ${plural(n.length, 'stash', 'stashes')}` : 'deletes a stash', lines: n.slice(0, 3) }
    }
    const stat = await git($, cwd, [...pre, 'diff', '--stat', '--', ...h.targets])
    const lines = (stat ?? '').split('\n').filter(Boolean)
    const summaryLine = lines.pop() ?? ''
    return { summary: lines.length ? `discards uncommitted edits: ${summaryLine.trim()}` : 'no uncommitted edits there to discard', lines: lines.slice(0, 5).map(l => l.trim()) }
  }
  if (h.kind === 'git-branch-delete') {
    const out: string[] = []
    let total = 0
    for (const b of h.targets) {
      const c = commitLines((await git($, cwd, [...pre, 'log', '--oneline', `HEAD..${b}`])) ?? '', 2)
      total += c.count
      out.push(`${b}: ${c.count ? plural(c.count, 'commit') + ' not in your current branch' : 'fully merged'}`, ...c.lines.map(l => `  ${l}`))
    }
    return { summary: total ? `deletes ${plural(h.targets.length, 'branch', 'branches')}; ${plural(total, 'commit')} exist only there` : `deletes ${plural(h.targets.length, 'branch', 'branches')} (nothing unmerged)`, lines: out }
  }
  return { summary: 'changes git history or files', lines: [] }
}

async function findImpact($: EngineInterface, h: Hit, cwd: string): Promise<Impact> {
  try {
    const r = await $.process.run(findDryRun(h.argv), { cwd, timeoutMs: GIT_MS })
    const found = r.stdout.split('\n').filter(Boolean)
    return { summary: found.length ? `deletes ${plural(found.length, 'match', 'matches')}` : 'nothing matches', lines: found.length ? [nameList(found.map(name => ({ name: name.replace(/^\.\//, '') })))] : [] }
  } catch {
    return { summary: 'could not preview (find failed)', lines: [] }
  }
}

/** The preview for one hit; never throws. */
export async function impactOf($: EngineInterface, h: Hit, sessionCwd: string): Promise<Impact> {
  const cwd = h.cd ? resolvePath(sessionCwd, await homeDir($), h.cd) : sessionCwd
  try {
    if (h.kind === 'rm') return await rmImpact($, h, cwd)
    if (h.kind === 'find-delete') return await findImpact($, h, cwd)
    if (h.kind === 'user') return { summary: `matches your pattern "${h.pattern}"`, lines: [] }
    return await gitImpact($, h, cwd)
  } catch (err) {
    return { summary: `could not preview (${String(err)})`, lines: [] }
  }
}

/** `/steward blast <command>`: the preview, without running anything (A-5.2 check). */
export async function blastPreview($: EngineInterface, line: string, userPatterns: readonly string[]): Promise<string> {
  if (!line.trim()) return 'usage: /steward blast <command>   (shows what it would touch; runs nothing)'
  const hits = findDestructive(line, userPatterns)
  if (!hits.length) return `Not destructive by Steward's rules; would run without asking: ${line}`
  const cwd = await $.session.cwd()
  const out: string[] = []
  for (const h of hits) {
    const i = await impactOf($, h, cwd)
    out.push(`${h.label}  →  ${i.summary}`, ...i.lines.map(l => `   ${l}`))
  }
  return `Blast preview (nothing was run):\n${out.join('\n')}`
}

// ── A-5.3 (PRD B-4): the Blast Radius dialog, asked from tool.call before Bash runs ──
export const PROCEED = 'Proceed'
export const CANCEL = 'Cancel'
export const ALLOW = 'Allow for session'

export type Verdict = { go: true } | { go: false; reason: string }

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Nothing runs before the person chooses. No dialog when nothing destructive is
 * found, or every hit is allowed this session. Headless (no surface to ask on):
 * fail open, logged to debug. A dismissed dialog counts as Cancel.
 */
export async function blastVerdict($: EngineInterface, command: string, userPatterns: readonly string[]): Promise<Verdict> {
  const allowed = await readAllowed($)
  const hits = findDestructive(command, userPatterns).filter(h => !allowed.some(p => matchesPattern(h.argv, p, false)))
  if (!hits.length) return { go: true }
  const target = short(hits.map(h => h.label).join('; '), 60)
  if (!(await $.session.surfaces()).length) {
    $.ui.log(`steward: blast guard could not ask (headless); allowed: ${target}`, { to: 'debug' })
    return { go: true }
  }
  const cwd = await $.session.cwd()
  const parts: string[] = []
  const summaries: string[] = []
  for (const h of hits) {
    const i = await impactOf($, h, cwd)
    summaries.push(`${h.label}: ${i.summary}`)
    parts.push(`${short(h.label)}\n→ ${i.summary}`, ...i.lines.slice(0, 4).map(l => `   ${short(l, 100)}`))
  }
  const what = hits.length === 1 ? 'This command' : `These ${hits.length} commands`
  let answer: string
  try {
    answer = await $.ui.ask(`${parts.join('\n')}\n\n${what} cannot be undone. Run it?`, { header: 'Blast radius', options: [PROCEED, CANCEL, ALLOW] })
  } catch {
    await noteGuard($, { kind: 'blast', target, outcome: 'blocked', at: Date.now() })
    return { go: false, reason: `Steward Blast Radius: the user dismissed the confirmation for \`${short(command, 200)}\`, so it did not run. Do not retry it or reach the same result another way; ask the user how to continue.` }
  }
  if (answer === PROCEED || answer === ALLOW) {
    if (answer === ALLOW) for (const h of hits) await allowForSession($, h.argv.join(' '))
    await noteGuard($, { kind: 'blast', target, outcome: 'proceeded', at: Date.now() })
    return { go: true }
  }
  await noteGuard($, { kind: 'blast', target, outcome: 'blocked', at: Date.now() })
  const impact = summaries.join('; ')
  if (answer === CANCEL) {
    return { go: false, reason: `Steward Blast Radius: the user cancelled \`${short(command, 200)}\` (${impact}). It did not run. Do not retry it or reach the same result another way; ask the user how to continue.` }
  }
  // Text typed under "Other": hand it to the model as the user's instruction.
  return { go: false, reason: `Steward Blast Radius: the user stopped \`${short(command, 200)}\` (${impact}) before it ran, with this instruction: "${answer}"` }
}
