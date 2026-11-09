// Pure: decides what the band shows (DESIGN §2.2 priority, §2.3 width).
// The band is the FALLBACK surface: when the pane is up it shows only alerts.

import type { Zone } from './zones'
import { usdText } from './cost'

export type Tone = 'calm' | 'info' | 'warn' | 'alert'
export type ActionId = 'handoff' | 'fresh' | 'auto' | 'warm' | 'cancel' | 'details' | 'pane'
export type Action = { id: ActionId; label: string }

export type BandInput = {
  zone: Zone
  pct: number
  tokensText: string
  cache: { minutesLeft: number | null; isCold: boolean; coldUsd?: number | null } | null
  handoff: 'idle' | 'countdown' | 'writing' | 'arrived'
  countdownSeconds: number
  others: { count: number; task: string | null }
  usage: { fiveHour: number | null; week: number | null; usd: number | null } | null
  paneUp: boolean
  quiet: boolean
}

export type Segment = { id: 'cache' | 'five' | 'week' | 'cost' | 'other'; text: string; short?: string; dropRank: number }

export type BandView = {
  state:
    | 'handoff' | 'cache-soon' | 'ctx-red' | 'cache-cold' | 'ctx-amber' | 'cache-warn' | 'other' | 'calm'
  icon: string
  tone: Tone
  lead: string
  actions: Action[]
  segments: Segment[]
}

/**
 * C-9 free-handoff moment: the cache is already cold, so the next message pays
 * full price anyway, and a handoff now costs nothing extra. Amber or red only.
 * Cold detection is real from Phase 4 (A-4.2); until then only the demo drives it.
 */
export const isFreeHandoff = (zone: 'green' | 'amber' | 'red', cache: { isCold: boolean } | null): boolean =>
  zone !== 'green' && !!cache?.isCold

export const FREE_HANDOFF_TEXT = 'cache cold, so handing off now costs nothing extra'

const ALERT_STATES: ReadonlySet<BandView['state']> = new Set([
  'handoff', 'cache-soon', 'ctx-red', 'cache-cold', 'ctx-amber',
])

function trailing(i: BandInput, skip: Set<Segment['id']>): Segment[] {
  const out: Segment[] = []
  const c = i.cache
  if (c && !skip.has('cache')) {
    out.push(c.isCold
      ? { id: 'cache', text: 'cache cold', short: '❄', dropRank: 5 }
      : c.minutesLeft !== null
        ? { id: 'cache', text: `cache ${c.minutesLeft}m`, short: '⏱', dropRank: 5 }
        : { id: 'cache', text: 'cache –', short: '⏱', dropRank: 5 })
  }
  const u = i.usage
  if (u) {
    if (u.fiveHour !== null) out.push({ id: 'five', text: `5h ${u.fiveHour}%`, dropRank: 3 })
    if (u.week !== null) out.push({ id: 'week', text: `wk ${u.week}%`, dropRank: 2 })
    if (u.usd !== null) out.push({ id: 'cost', text: `$${u.usd.toFixed(2)}`, dropRank: 1 })
  }
  if (i.others.count > 0 && !skip.has('other')) {
    out.push({ id: 'other', text: `◆ ${i.others.count} other session${i.others.count > 1 ? 's' : ''}`, short: '◆', dropRank: 4 })
  }
  return out
}

/** A-4.4: "  next msg ≈ $1.90 uncached", or nothing when the price is unknown. */
const cost = (c: { coldUsd?: number | null }, tail: string): string =>
  typeof c.coldUsd === 'number' ? ` · next msg ≈ ${usdText(c.coldUsd)}${tail}` : ''

/** Returns null when the band should draw nothing. */
export function resolveBand(i: BandInput): BandView | null {
  const ctx = `ctx ${i.pct}%`
  const c = i.cache
  let v: BandView

  if (i.handoff !== 'idle') {
    const lead = i.handoff === 'countdown' ? `auto-handoff in ${i.countdownSeconds}s …`
      : i.handoff === 'writing' ? 'writing handoff brief …'
      : 'handoff arrived: brief is in the prompt box, review and send'
    v = { state: 'handoff', icon: i.handoff === 'arrived' ? '✓' : '↻', tone: 'info', lead,
      actions: i.handoff === 'countdown' ? [{ id: 'cancel', label: 'cancel' }] : [], segments: [] }
  } else if (c && !c.isCold && c.minutesLeft !== null && c.minutesLeft <= 5) {
    v = { state: 'cache-soon', icon: '⏱', tone: 'warn', lead: `cache cold in ${c.minutesLeft}m (est.)${cost(c, ' uncached')}`,
      actions: [{ id: 'warm', label: 'keep warm' }, { id: 'handoff', label: 'handoff & clear' }],
      segments: trailing(i, new Set(['cache'])) }
  } else if (i.zone === 'red') {
    v = { state: 'ctx-red', icon: '■', tone: 'alert', lead: `${ctx} · ${i.tokensText} · hand off now${isFreeHandoff(i.zone, c) ? ` · ${FREE_HANDOFF_TEXT}` : ''}`,
      actions: [{ id: 'handoff', label: 'handoff → new' }, { id: 'fresh', label: 'fresh' }, { id: 'auto', label: 'auto' }],
      segments: trailing(i, new Set()) }
  } else if (c && c.isCold) {
    v = { state: 'cache-cold', icon: '❄', tone: 'warn', lead: isFreeHandoff(i.zone, c) ? `${ctx} · ${FREE_HANDOFF_TEXT} (est.)` : `cache cold (est.)${cost(c, '')}`,
      actions: [{ id: 'handoff', label: 'handoff & clear' }], segments: trailing(i, new Set(['cache'])) }
  } else if (i.zone === 'amber') {
    v = { state: 'ctx-amber', icon: '▲', tone: 'warn', lead: `${ctx} · ${i.tokensText} · quality may drop`,
      actions: [{ id: 'handoff', label: 'handoff → new' }, { id: 'fresh', label: 'fresh' }, { id: 'auto', label: 'auto' }],
      segments: trailing(i, new Set()) }
  } else if (c && !c.isCold && c.minutesLeft !== null && c.minutesLeft < 10) {
    v = { state: 'cache-warn', icon: '⏱', tone: 'info', lead: `cache cold in ${c.minutesLeft}m (est.)`,
      actions: [{ id: 'warm', label: 'keep warm' }], segments: trailing(i, new Set(['cache'])) }
  } else if (i.others.count > 0) {
    v = { state: 'other', icon: '◆', tone: 'info',
      lead: `${ctx} · other session${i.others.task ? `: "${i.others.task}"` : ''}`,
      actions: [{ id: 'details', label: 'details' }], segments: trailing(i, new Set(['other'])) }
  } else {
    v = { state: 'calm', icon: '●', tone: 'calm', lead: ctx, actions: [], segments: trailing(i, new Set()) }
  }

  // Pane-first: with the pane up, the band only speaks for alerts.
  if (i.paneUp && !ALERT_STATES.has(v.state)) return null
  if (!i.paneUp) {
    if (i.quiet && v.state === 'calm') return null
    v = { ...v, actions: [...v.actions, { id: 'pane', label: 'Steward' }] }
  }
  return v
}

const SEP = '  ·  '
const actionWidth = (a: Action) => a.label.length + 5 // "1: " + gap

export function bandWidth(v: Pick<BandView, 'lead' | 'actions' | 'segments'>): number {
  const segs = v.segments.map(s => s.text).join(SEP)
  return 2 + v.lead.length + (segs ? SEP.length + segs.length : 0) + v.actions.reduce((n, a) => n + actionWidth(a), 0)
}

/**
 * Fits the band into `columns`: segments shrink (short form) or drop by dropRank,
 * lowest first. Under 40 columns, compact: lead + first action only.
 */
export function fitBand(v: BandView, columns: number): BandView {
  if (columns < 40) {
    return { ...v, segments: [], actions: v.actions.slice(0, 1), lead: v.lead.split(' · ')[0] ?? v.lead }
  }
  let segs = [...v.segments]
  const ranks = [...new Set(segs.map(s => s.dropRank))].sort((a, b) => a - b)
  for (const r of ranks) {
    if (bandWidth({ ...v, segments: segs }) <= columns) break
    segs = segs.flatMap(s => (s.dropRank !== r ? [s] : s.short ? [{ ...s, text: s.short, short: undefined }] : []))
    if (bandWidth({ ...v, segments: segs }) <= columns) break
    segs = segs.filter(s => s.dropRank !== r)
  }
  return { ...v, segments: segs }
}
