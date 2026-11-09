// Steward's state contract. Event hooks write these; the pane and band only read them.

export type Live = {
  tokens: number | null
  window: number | null
  percent: number | null
  autoCompactAt: number | null
  fiveHour: number | null
  fiveHourResets: string | null
  week: number | null
  weekResets: string | null
  usd: number | null
}

/** Cache view; filled for real in Phase 4. */
/** A-4.2: estimated prompt-cache countdown. lastAt null = no main-thread reply yet (K-8). */
export type CacheView = {
  minutesLeft: number | null
  secondsLeft: number | null
  isCold: boolean
  ttlMinutes: number
  lastAt: number | null
  /** K-9: the last main turn's cache figures (summed over its requests). */
  hit: { read: number; written: number; isHit: boolean } | null
}

/** Handoff progress; filled for real in Phase 3. */
export type HandoffView =
  | { phase: 'idle' }
  | { phase: 'countdown'; secondsLeft: number }
  | { phase: 'writing' }
  | { phase: 'arrived' }

export type OtherSession = { id: string; task: string; status: 'working' | 'idle'; files: string[] }

export type GuardEvent = { kind: 'collision' | 'blast'; target: string; outcome: 'proceeded' | 'blocked'; at: number }

export type Demo = 'off' | 'amber' | 'red' | 'cache-warn' | 'cache-cold' | 'free-handoff' | 'countdown' | 'other'

/** A "Claude seems off" calibration mark (C-10), kept across sessions in $.store. */
export type OffMark = { tokens: number | null; window: number | null; pct: number; zone: 'green' | 'amber' | 'red'; turn: number; at: number }

/** Effective auto-handoff setting (A-2.3); mirrors core/auto.ts AutoView. */
export type AutoState = { on: boolean; atTokens: number | null; source: 'project' | 'user' | 'default' }

/** A task boundary Steward noticed in amber/red (A-2.6). */
export type Boundary = { why: string; at: number }

/** A-3.6: a brief in .claude/handoffs/, newest first. */
export type BriefFile = { name: string; path: string; at: number; preview: boolean }
export type Briefs = { list: BriefFile[]; week: number }

export type ZoneMark = 'none' | 'green' | 'amber' | 'red'

export type SectionId = 'context' | 'cache' | 'usage' | 'sessions' | 'guards' | 'handoffs' | 'commands'

declare module 'claude-code' {
  interface PluginState {
    steward: {
      live: Shaped<Live>
      cache: Shaped<CacheView>
      handoff: Shaped<HandoffView>
      others: Shaped<OtherSession[]>
      guards: Shaped<GuardEvent[]>
      demo: Demo
      paneUp: boolean
      paneBehind: boolean
      collapsed: Shaped<SectionId[]>
      lastZone: ZoneMark
      tick: number
      auto: Shaped<AutoState>
      snoozed: boolean
      tasks: Shaped<Record<string, 'pending' | 'in_progress' | 'completed'>>
      boundary: Shaped<Boundary | null>
      boundaryShown: boolean
      turns: number
      marks: Shaped<OffMark[]>
      briefs: Shaped<Briefs>
      model: string | null
      allowed: Shaped<string[]>
    }
  }
}
