// Pure: A-5.1 (PRD B-1) shell tokenizer and destructive-command matcher.
// Commands are tokenized, never regex-matched on the raw string: quotes, escapes,
// `;` `&&` `||` `|` `&` newlines, `( )`, `$( )` and backticks split a command line
// into simple commands, each matched on its own. When unsure, it errs toward
// matching (a needless question is cheap; a missed `rm -rf` is not).

export type Kind =
  | 'rm' | 'git-push-force' | 'git-reset-hard' | 'git-clean' | 'git-discard'
  | 'git-branch-delete' | 'find-delete' | 'user'

export type Hit = {
  kind: Kind
  /** The simple command as words, wrapper words (sudo, env, …) removed. */
  argv: string[]
  /** What it acts on: rm/find/discard paths, the reset target, the push refs. */
  targets: string[]
  /** "rm -rf build/" style text for the dialog. */
  label: string
  /** For a user pattern: the pattern that matched. */
  pattern?: string
  /** The directory a `cd` earlier on the same line moved to, if any. */
  cd?: string
}

const OPS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '$(', '`', '|&', ';;'])

/**
 * Words and operators. Quotes are removed, escapes applied. `$(…)` and backticks
 * become separators, so the commands inside them are checked like any other.
 * Unbalanced quotes are closed at the end (still checked, never skipped).
 */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let word = ''
  let has = false // a quoted empty string is still a word
  const push = () => { if (has) out.push(word); word = ''; has = false }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    const n = line[i + 1]
    if (c === '\\') {
      if (n === '\n') { i++; continue }
      if (n !== undefined) { word += n; has = true; i++ }
      continue
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word += line.slice(i + 1, end < 0 ? undefined : end); has = true
      i = end < 0 ? line.length : end
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) j++
        word += line[j]
      }
      has = true
      i = j
      continue
    }
    if (c === ' ' || c === '\t') { push(); continue }
    if (c === '#' && !has) { // a comment runs to the end of the line
      const nl = line.indexOf('\n', i)
      if (nl < 0) break
      i = nl - 1
      continue
    }
    const two = c + (n ?? '')
    if (two === '&&' || two === '||' || two === '$(' || two === '|&' || two === ';;') { push(); out.push(two); i++; continue }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '`') { push(); out.push(c); continue }
    if (c === '>' || c === '<') { push(); continue } // redirections: drop the operator, keep the file word
    word += c; has = true
  }
  push()
  return out
}

/** Simple commands: the words between operators, empty ones dropped. */
export function commands(line: string): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  for (const t of tokenize(line)) {
    if (OPS.has(t)) { if (cur.length) out.push(cur); cur = [] } else cur.push(t)
  }
  if (cur.length) out.push(cur)
  return out
}

const base = (w: string) => w.slice(w.lastIndexOf('/') + 1)
const isAssign = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)

/**
 * Removes what only runs another command: `FOO=1`, sudo, env, command, exec,
 * nohup, time, nice, doas, xargs (its command takes stdin as arguments).
 * `bash -c '…'`, `sh -c`, `eval` are returned as nested command lines.
 */
export function unwrap(argv: string[]): { argv: string[]; nested: string[]; viaXargs: boolean } {
  let a = [...argv]
  let viaXargs = false
  for (let guard = 0; guard < 10 && a.length; guard++) {
    while (a.length && isAssign(a[0]!)) a.shift()
    const cmd = base(a[0] ?? '')
    if (cmd === 'sudo' || cmd === 'doas') {
      a.shift()
      while (a.length && a[0]!.startsWith('-')) { const f = a.shift()!; if (/^-[ugCDhpRrTt]$/.test(f)) a.shift() }
    } else if (cmd === 'env') {
      a.shift()
      while (a.length && (a[0]!.startsWith('-') || isAssign(a[0]!))) a.shift()
    } else if (cmd === 'command' || cmd === 'exec' || cmd === 'nohup' || cmd === 'time' || cmd === 'builtin') {
      a.shift()
      while (a.length && a[0]!.startsWith('-')) a.shift()
    } else if (cmd === 'nice' || cmd === 'ionice' || cmd === 'timeout') {
      a.shift()
      while (a.length && a[0]!.startsWith('-')) { const f = a.shift()!; if (f === '-n' || f === '-c') a.shift() }
      if (cmd === 'timeout' && a.length) a.shift() // the duration
    } else if (cmd === 'xargs') {
      viaXargs = true
      a.shift()
      while (a.length && a[0]!.startsWith('-')) { const f = a.shift()!; if (/^-[IEdLnPs]$/.test(f)) a.shift() }
    } else if ((cmd === 'bash' || cmd === 'sh' || cmd === 'zsh' || cmd === 'dash') && a.includes('-c')) {
      const at = a.indexOf('-c')
      return { argv: [], nested: a[at + 1] !== undefined ? [a[at + 1]!] : [], viaXargs }
    } else if (cmd === 'eval') {
      return { argv: [], nested: [a.slice(1).join(' ')], viaXargs }
    } else break
  }
  return { argv: a, nested: [], viaXargs }
}

/** Short flags as letters ("-rf" → r, f), long flags whole; stops at `--`. */
function flagsOf(args: string[]): { short: Set<string>; long: Set<string>; rest: string[] } {
  const short = new Set<string>(), long = new Set<string>(), rest: string[] = []
  let done = false
  for (const w of args) {
    if (done) { rest.push(w); continue }
    if (w === '--') { done = true; continue }
    if (w.startsWith('--')) long.add(w.split('=')[0]!)
    else if (w.startsWith('-') && w.length > 1) for (const ch of w.slice(1)) short.add(ch)
    else rest.push(w)
  }
  return { short, long, rest }
}

const GLOB = /[*?[]/

function matchRm(a: string[]): Hit | null {
  const { short, long, rest } = flagsOf(a.slice(1))
  const recursive = short.has('r') || short.has('R') || long.has('--recursive')
  if (!recursive && !rest.some(p => GLOB.test(p))) return null
  return { kind: 'rm', argv: a, targets: rest, label: a.join(' ') }
}

/** Git's own options before the subcommand: -C dir, -c k=v, --git-dir=…, … */
function gitSub(a: string[]): { sub: string; args: string[] } {
  let i = 1
  while (i < a.length && a[i]!.startsWith('-')) {
    const f = a[i]!
    i += f === '-C' || f === '-c' || f === '--git-dir' || f === '--work-tree' || f === '--namespace' ? 2 : 1
  }
  return { sub: a[i] ?? '', args: a.slice(i + 1) }
}

function matchGit(a: string[]): Hit | null {
  const { sub, args } = gitSub(a)
  const { short, long, rest } = flagsOf(args)
  const hit = (kind: Kind, targets: string[]): Hit => ({ kind, argv: a, targets, label: a.join(' ') })
  if (sub === 'push') {
    const force = short.has('f') || long.has('--force') || long.has('--force-with-lease') || long.has('--force-if-includes') || long.has('--mirror') || long.has('--delete') || short.has('d')
    const plus = rest.filter(r => r.startsWith('+') || r.startsWith(':'))
    return force || plus.length ? hit('git-push-force', rest) : null
  }
  if (sub === 'reset') return long.has('--hard') || long.has('--merge') || long.has('--keep') ? hit('git-reset-hard', rest.length ? rest : ['HEAD']) : null
  if (sub === 'clean') {
    const dry = short.has('n') || long.has('--dry-run')
    return !dry && (short.has('f') || long.has('--force')) ? hit('git-clean', rest.length ? rest : ['.']) : null
  }
  if (sub === 'checkout') {
    const dashdash = args.indexOf('--')
    if (dashdash >= 0 && args.length > dashdash + 1) return hit('git-discard', args.slice(dashdash + 1))
    if (short.has('f') || long.has('--force')) return hit('git-discard', rest.length ? rest : ['.'])
    if (rest.length === 1 && (rest[0] === '.' || GLOB.test(rest[0]!))) return hit('git-discard', rest)
    return null
  }
  if (sub === 'restore') {
    const onlyStaged = (short.has('S') || long.has('--staged')) && !(short.has('W') || long.has('--worktree'))
    return !onlyStaged && rest.length ? hit('git-discard', rest) : null
  }
  if (sub === 'branch') {
    const del = short.has('D') || ((short.has('d') || long.has('--delete')) && (short.has('f') || long.has('--force')))
    return del ? hit('git-branch-delete', rest) : null
  }
  if (sub === 'stash' && (args[0] === 'drop' || args[0] === 'clear')) return hit('git-discard', [`stash ${args.slice(0, 2).join(' ')}`.trim()])
  return null
}

function matchFind(a: string[]): Hit | null {
  const del = a.includes('-delete') || a.some((w, i) => (w === '-exec' || w === '-execdir' || w === '-ok') && base(a[i + 1] ?? '') === 'rm')
  if (!del) return null
  const roots: string[] = []
  for (const w of a.slice(1)) { if (w.startsWith('-') || w === '!' || w === '(') break; roots.push(w) }
  return { kind: 'find-delete', argv: a, targets: roots.length ? roots : ['.'], label: a.join(' ') }
}

/**
 * A pattern is words; `*` matches any one word, a trailing `**` any rest.
 * `rm -rf node_modules` matches exactly those words (flags as written).
 * prefix: the command may go on after the pattern (user destructive patterns);
 * otherwise the whole command must match (allow patterns, B-5).
 */
export function matchesPattern(argv: string[], pattern: string, prefix: boolean): boolean {
  const p = pattern.trim().split(/\s+/).filter(Boolean)
  if (!p.length || !argv.length) return false
  const a = [base(argv[0]!), ...argv.slice(1)]
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**' && i === p.length - 1) return true
    if (i >= a.length) return false
    const want = i === 0 ? base(p[i]!) : p[i]!
    if (want !== '*' && want !== a[i]) return false
  }
  return prefix || a.length === p.length
}

/** Every destructive simple command in a command line (nested `bash -c` included). */
export function findDestructive(line: string, userPatterns: readonly string[] = [], depth = 0): Hit[] {
  const out: Hit[] = []
  let cd: string | undefined
  for (const words of commands(line)) {
    if (base(words[0] ?? '') === 'cd') { cd = words[1] && words[1] !== '-' ? (cd && !words[1].startsWith('/') && !words[1].startsWith('~') ? `${cd}/${words[1]}` : words[1]) : undefined; continue }
    const u = unwrap(words)
    if (depth < 3) for (const n of u.nested) out.push(...findDestructive(n, userPatterns, depth + 1))
    const a = u.argv
    if (!a.length) continue
    const cmd = base(a[0]!)
    const h = cmd === 'rm' ? (u.viaXargs ? { kind: 'rm' as const, argv: a, targets: ['(paths from input)'], label: a.join(' ') } : matchRm(a))
      : cmd === 'git' ? matchGit(a)
      : cmd === 'find' ? matchFind(a)
      : null
    if (h) { out.push(cd ? { ...h, cd } : h); continue }
    const p = userPatterns.find(pt => matchesPattern(a, pt, true))
    if (p) out.push({ kind: 'user', argv: a, targets: a.slice(1).filter(w => !w.startsWith('-')), label: a.join(' '), pattern: p, ...(cd ? { cd } : {}) })
  }
  return out
}

/** userConfig list: patterns separated by `;` (commas can be part of a command). */
export const parsePatterns = (s: unknown): string[] =>
  typeof s === 'string' ? s.split(';').map(x => x.trim()).filter(Boolean) : []
