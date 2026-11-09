// Pure: A-5.2 (PRD B-3) helpers for the impact preview's text.

export type Impact = {
  /** "deletes 214 files, 38 MB" */
  summary: string
  /** A few detail lines: names, commits, files. */
  lines: string[]
}

/** A glob for ONE path segment (`*.log`, `a?c`, `[ab]*`) as a RegExp. */
export function globToRegExp(seg: string): RegExp {
  let re = '^'
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2)
      if (end < 0) { re += '\\['; continue }
      let body = seg.slice(i + 1, end).replace(/\\/g, '\\\\')
      if (body.startsWith('!')) body = '^' + body.slice(1)
      re += `[${body}]`
      i = end
    } else re += c.replace(/[.+^${}()|\\]/g, m => `\\${m}`)
  }
  return new RegExp(re + '$')
}

export const hasGlob = (s: string): boolean => /[*?[]/.test(s)

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "build/app.js · build/assets/ (201) · build/index.html … (+12 more)" */
export function nameList(items: readonly { name: string; count?: number }[], max = 5): string {
  const shown = items.slice(0, max).map(x => (x.count !== undefined ? `${x.name}/ (${x.count})` : x.name))
  const more = items.length - shown.length
  return shown.join(' · ') + (more > 0 ? ` … (+${more} more)` : '')
}

/** Joins a path the way a shell would see it from `cwd` (no `..` folding needed for display). */
export function resolvePath(cwd: string, home: string | null, p: string): string {
  if (p.startsWith('/')) return p.replace(/\/+$/, '') || '/'
  if (p === '~' || p.startsWith('~/')) return home ? `${home}${p.slice(1)}`.replace(/\/+$/, '') : p
  const joined = `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\/+/, '')}`
  return joined.replace(/\/\.$/, '').replace(/\/+$/, '') || '/'
}

/** `git log --oneline` lines → "3 commits: a1b2c3d fix x · …" */
export function commitLines(log: string, max = 4): { count: number; lines: string[] } {
  const all = log.split('\n').map(l => l.trim()).filter(Boolean)
  const lines = all.slice(0, max)
  if (all.length > max) lines.push(`… (+${all.length - max} more)`)
  return { count: all.length, lines }
}

/** Mirror of a `find` that deletes, made harmless: drops `-delete` and `-exec rm … ;|+`. */
export function findDryRun(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!
    if (w === '-delete') continue
    if ((w === '-exec' || w === '-execdir' || w === '-ok') && (argv[i + 1] ?? '').replace(/^.*\//, '') === 'rm') {
      while (i < argv.length && argv[i] !== ';' && argv[i] !== '+') i++
      continue
    }
    out.push(w)
  }
  return [...out, '-print']
}
