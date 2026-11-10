// One snapshot both surfaces draw from, so the pane and band never disagree.
// Reading atoms here, from inside a render hook, subscribes that render.
import type { EngineInterface } from 'claude-code'
import { parseBriefModel } from './core/brief'
import { coldCostUsd, parsePrices, pricePerM } from './core/cost'
import { parsePatterns } from './core/shell'
import type { Price } from './core/cost'
import type { BriefModel } from './core/brief'

import type { Briefs, AutoState, Boundary, CacheView, Demo, GuardEvent, HandoffView, Live, OffMark, OtherSession, SectionId } from '../types'
import { readAll } from './state'
import { zoneOf, shortTokens } from './core/zones'
import type { ZoneConfig, ZoneResult } from './core/zones'

export type Features = { context: boolean; cache: boolean; usage: boolean; collision: boolean; blast: boolean }
export type Config = { features: Features; openPaneAtStart: boolean; quiet: boolean; zones: ZoneConfig; briefModel: BriefModel; cacheLeadMinutes: number; prices: Price[]; blastPatterns: string[]; collisionWindowMinutes: number }

export type Snapshot = {
  live: Live
  tokens: number | null
  pct: number
  tokensText: string
  zone: ZoneResult
  cache: CacheView
  handoff: HandoffView
  others: OtherSession[]
  guards: GuardEvent[]
  allowSaved: string[]
  allowSession: string[]
  demo: Demo
  paneUp: boolean
  paneBehind: boolean
  collapsed: SectionId[]
  marks: OffMark[]
  briefs: Briefs
  auto: AutoState
  boundary: Boundary | null
  /** A-4.4: next message's cost if the cache is cold (est.), or null when unknown. */
  coldUsd: number | null
  model: string | null
}

export async function snapshot($: EngineInterface, cfg: Config): Promise<Snapshot> {
  const st = await readAll($)
  const l = st.live
  const d = st.demo
  let c = st.cache
  let h = st.handoff
  let o = st.others

  // Real zone thresholds first, so a demo can sit just past them.
  const base = zoneOf(l.tokens, l.window, l.autoCompactAt, cfg.zones)
  let tokens = l.tokens
  if (d === 'amber' || d === 'free-handoff') tokens = Math.round((base.amberAt + base.redAt) / 2)
  if (d === 'red') tokens = base.redAt + 20_000
  if (d === 'cache-warn') c = { ...c, minutesLeft: 4, secondsLeft: 240, isCold: false }
  if (d === 'cache-cold' || d === 'free-handoff') c = { ...c, minutesLeft: null, secondsLeft: null, isCold: true }
  if (d === 'countdown') h = { phase: 'countdown', secondsLeft: 10 }
  if (d === 'other') o = [{ id: 'demo', task: 'add Most Popular badge', status: 'working', files: ['src/pricing.html'] }]

  const zone = zoneOf(tokens, l.window, l.autoCompactAt, cfg.zones)
  const pct = l.window && tokens !== null ? Math.round((tokens / l.window) * 100) : (l.percent ?? 0)

  return {
    live: l,
    tokens,
    pct,
    tokensText: `${shortTokens(tokens)} / ${shortTokens(l.window)}`,
    zone,
    cache: c,
    handoff: h,
    others: o,
    guards: st.guards,
    allowSaved: st.savedAllow,
    allowSession: st.allowed,
    demo: d,
    paneUp: st.paneUp,
    paneBehind: st.paneBehind,
    collapsed: st.collapsed,
    marks: st.marks,
    briefs: st.briefs,
    auto: st.auto,
    boundary: st.boundary,
    coldUsd: coldCostUsd(tokens, pricePerM(st.model, tokens ?? 0, cfg.prices), c.ttlMinutes),
    model: st.model,
  }
}

type UsageLike = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

/** Pure: maps `session.measure` or `$.session.usage()` onto Steward's live figures. */
export function liveFrom(u: UsageLike): Partial<Live> {
  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  return {
    tokens: u.context.tokens ?? null,
    window: u.context.window ?? null,
    percent: u.context.percent ?? null,
    fiveHour: five?.percentUsed ?? null,
    fiveHourResets: five?.resetsAt ?? null,
    week: week?.percentUsed ?? null,
    weekResets: week?.resetsAt ?? null,
    usd: u.cost?.usd ?? null,
  }
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const on = (k: string, dflt: boolean) => (options[k] === undefined ? dflt : options[k] === 'on' || options[k] === true)
  const num = (k: string, dflt: number) => {
    const n = Number(options[k])
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  return {
    features: {
      context: on('context', true), cache: on('cache', true), usage: on('usage', true),
      collision: on('collision', true), blast: on('blast', true),
    },
    openPaneAtStart: on('pane', true),
    quiet: on('quiet', false),
    zones: { amberTokens: num('amber', 250_000), redTokens: num('red', 400_000) },
    briefModel: parseBriefModel(options['briefModel']),
    blastPatterns: parsePatterns(options['blastPatterns']),
    prices: parsePrices(typeof options['prices'] === 'string' ? options['prices'] : undefined),
    cacheLeadMinutes: options['cacheLead'] === '0' ? 0 : num('cacheLead', 5),
    collisionWindowMinutes: num('collisionWindow', 30),
  }
}
