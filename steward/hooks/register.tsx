// Steward v0.1 (Phase 1 shell): pane-first cockpit + fallback band.
// Hooks write atoms; the two render hooks only read the shared snapshot.
// Every non-render hook is wrapped `.catch(... next(e))`: a Steward bug never blocks
// the session (D-6); the engine logs the failure to the debug log.
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { SectionId } from '../types'
import { PANE_ID, autoCommand, cancelCountdown, closePane, dismissBoundary, noteTool, fillCommand, maybeArm, markOff, openPane, runAction, syncPane, toggleSection, togglePane } from './actions'
import { autoCompactFrom, bar, shortTokens, zoneOf, zoneToast } from './core/zones'
import { FREE_HANDOFF_TEXT, fitBand, isFreeHandoff, resolveBand } from './core/band'
import { resetIn } from './core/time'
import type { Tone } from './core/band'
import { syncSavedAllow, setModel, bumpTick, countTurn, loadAuto, readLive, restoreCollapsed, restoreMarks, setDemo, setLive, setPaneUp, swapZone } from './state'
import { abortAutoWrite, catchEditedBrief, previewBrief, refreshBriefs, scheduleReseed, useBriefModel } from './handoff'
import { allowCommand, blastPreview, blastVerdict } from './blast'
import { endHeartbeat, heartbeat, noteEdit, startHeartbeat } from './registry'
import { collisionVerdict } from './collision'
import { perfReport } from './perf'
import { normPath } from './core/registry'
import { noteResponse, resetCache, startCache, ttlCommand, useCacheLead } from './cache'
import { leftText } from './core/cache'
import { usdText } from './core/cost'
import { liveFrom, parseConfig, snapshot } from './view'
import type { Config } from './view'
import type { Demo, GuardEvent } from '../types'

const DEMOS: readonly Demo[] = ['off', 'amber', 'red', 'cache-warn', 'cache-cold', 'free-handoff', 'countdown', 'other']
const SECTIONS: readonly { id: SectionId; title: string; hotkey: string }[] = [
  { id: 'context', title: 'CONTEXT', hotkey: '1' },
  { id: 'cache', title: 'CACHE', hotkey: '2' },
  { id: 'usage', title: 'USAGE', hotkey: '3' },
  { id: 'sessions', title: 'SESSIONS HERE', hotkey: '4' },
  { id: 'guards', title: 'GUARDS', hotkey: '5' },
  { id: 'handoffs', title: 'HANDOFFS', hotkey: '6' },
  { id: 'commands', title: 'COMMANDS', hotkey: '7' },
]

// COMMANDS section: [what is put in the prompt, what it does]. A trailing space
// means the person finishes it (a value to type).
const COMMANDS: readonly (readonly [string, string])[] = [
  ['/steward', 'show or hide this pane'],
  ['/steward status', 'one-line summary'],
  ['/steward mark', 'log "Claude seems off" here'],
  ['/steward auto', 'show the auto-handoff setting'],
  ['/steward auto on', 'auto-handoff on, at red'],
  ['/steward auto off', 'auto-handoff off'],
  ['/steward auto 300K', 'auto-handoff at 300K tokens'],
  ['/steward auto here ', 'same, this project only: on | off | 300K | reset'],
  ['/steward demo ', 'preview: amber | red | cache-warn | cache-cold | free-handoff | countdown | other | off'],
  ['/steward brief', 'preview a handoff brief (nothing is cleared)'],
  ['/steward ttl ', 'cache window estimate in minutes, e.g. 5 or 60'],
  ['/steward blast ', 'preview what a destructive command would touch (runs nothing)'],
  ['/steward allow', 'commands that run without the Blast radius question'],
  ['/steward allow ', 'save one, e.g. rm -rf node_modules  (remove <cmd> to undo)'],
  ['/steward help', 'all commands'],
]
const TONE_COLOR: Record<Tone, string | undefined> = { calm: undefined, info: 'suggestion', warn: 'warning', alert: 'error' }
const ZONE_COLOR = { green: 'success', amber: 'warning', red: 'error' } as const

const HELP = [
  '/steward              toggle the Steward pane',
  '/steward status       one-line summary',
  '/steward demo <s>     preview a state: ' + DEMOS.join(' | '),
  '/steward brief        write a handoff brief preview to .claude/handoffs/ (no clear)',
  '/steward ttl [<min>]  show or set the cache window estimate (default 60)',
  '/steward blast <cmd>  preview what a destructive command would touch; runs nothing',
  '/steward allow [remove] <cmd>  save (or remove) a command Blast radius never asks about; no args lists them',
  '/steward perf         how long the collision and blast checks take before a tool runs (p50 / p95)',
  '/steward mark         log "Claude seems off" at the current context size',
  '/steward auto [here] on|off|<tokens>   auto-handoff (here = this project; /steward auto here reset)',
  '/steward handoff      write a brief, then confirm: Proceed / Edit brief first / Cancel',
  '/steward fresh        clear the session after a confirm (no brief)',
  '/steward ping         keep the cache warm now (only when you ask)',
  '/steward cancel       cancel a running auto-handoff countdown',
].join('\n')

// A-2.2: the real auto-compact point. The `summary` breakdown is a local
// estimate (no API call), but still more than the plain call, so it runs only
// at start, when the window changes, and on /steward status.
async function refresh($: EngineInterface): Promise<void> {
  const u = await $.session.usage({ breakdown: 'summary' })
  await setLive($, { ...liveFrom(u), autoCompactAt: autoCompactFrom(u.context.breakdown) })
  await setModel($, await $.session.model())
}

// Toast only when the REAL zone moves (demo never toasts, first reading never toasts).
async function checkZone($: EngineInterface, cfg: Config): Promise<void> {
  const l = await readLive($)
  if (l.tokens === null) return
  const z = zoneOf(l.tokens, l.window, l.autoCompactAt, cfg.zones)
  const prev = await swapZone($, z.zone)
  const msg = zoneToast(prev === 'none' ? null : prev, z, l.tokens, l.autoCompactAt)
  if (msg && cfg.features.context) await $.ui.toast(msg)
}

// One minute ticker for the pane's countdowns (A-2.5). Kept here so a hot
// reload's new session.start cancels the old one instead of stacking.
// Plus a 5 s pane-visibility poll (A-2.9): the engine raises no event when
// another tab (e.g. Files) comes in front of the pane.
let timers: Timer[] = []

function startTicker($: EngineInterface): void {
  for (const t of timers) t.cancel()
  timers = [
    $.clock.every(60_000, () => { void bumpTick($) }),
    $.clock.every(5_000, () => { void syncPane($) }),
  ]
}

// /steward router. Replies without the "Steward: " toast prefix (the engine adds "steward:").
async function stewardCommand($: EngineInterface, args: string, cfg: Config): Promise<string> {
  const e = { args }
  const [sub = '', arg] = e.args.trim().split(/\s+/)
  const rest = e.args.trim().slice(sub.length)
  switch (sub) {
    case '': return await togglePane($)
    case 'open': return await openPane($, true)
    case 'close': return await closePane($)
    case 'help': return HELP
    case 'auto': return await autoCommand($, rest)
    case 'handoff': case 'fresh': case 'cancel':
      return await runAction($, sub)
    case 'ping': return await runAction($, 'warm')
    case 'brief': return await previewBrief($, cfg.briefModel)
    case 'ttl': return await ttlCommand($, arg)
    case 'blast': return await blastPreview($, rest, cfg.blastPatterns)
    case 'allow': return await allowCommand($, rest)
    case 'perf': return perfReport()
    case 'mark': return await markOff($, cfg.zones)
    case 'demo': {
      const want = DEMOS.find(d => d === arg) ?? 'off'
      await setDemo($, want)
      return want === 'off' ? 'Steward demo off: real figures.' : `Steward demo: ${want}. /steward demo off to return.`
    }
    case 'status': {
      await refresh($)
      await checkZone($, cfg)
      const s = await snapshot($, cfg)
      return `ctx ${s.pct}% (${s.tokensText}, ${s.zone.zone}; amber ${shortTokens(s.zone.amberAt)}, red ${shortTokens(s.zone.redAt)}; auto-compact ${s.live.autoCompactAt ? shortTokens(s.live.autoCompactAt) : 'off'})${s.live.fiveHour !== null ? ` · 5h ${s.live.fiveHour}%` : ''}${s.live.week !== null ? ` · wk ${s.live.week}%` : ''}${s.live.usd !== null ? ` · $${s.live.usd.toFixed(2)}` : ''}`
    }
    default: return `Unknown: /steward ${sub}\n${HELP}`
  }
}

/** A-6.5: a heartbeat that can never break the hook it rides on. */
async function safeBeat($: EngineInterface, patch: Parameters<typeof heartbeat>[1]): Promise<void> {
  try { await heartbeat($, patch) } catch (err) { $.ui.log(`steward: heartbeat failed: ${String(err)}`, { to: 'debug' }) }
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  useBriefModel(cfg.briefModel)
  useCacheLead(cfg.features.cache ? cfg.cacheLeadMinutes : 0)


  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'steward', description: 'Steward cockpit: toggle the pane · /steward help' })
    await restoreCollapsed($)
    await restoreMarks($)
    await loadAuto($)
    // session.measure fires only when a figure CHANGES; seed now so a fresh
    // load or hot reload shows real numbers at once (the plain call is free).
    await refresh($)
    await checkZone($, cfg)
    startTicker($)
    await refreshBriefs($)
    await startCache($)
    try { await syncSavedAllow($) } catch { /* the pane shows 0 saved; the guard reads the store itself */ }
    if (cfg.features.collision) try { await startHeartbeat($) } catch (err) { $.ui.log(`steward: heartbeat start failed: ${String(err)}`, { to: 'debug' }) }
    if (cfg.openPaneAtStart) void openPane($, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const before = await readLive($)
    if (e.context.window !== before.window) await refresh($)
    else await setLive($, liveFrom(e))
    await checkZone($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Main-session turn count, for calibration marks (subagent turns carry an agentId).
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await countTurn($)
      // A-2.4: between turns only. Fresh figures first (the plain usage call is free).
      await setLive($, liveFrom(await $.session.usage()))
      if (cfg.features.context) await maybeArm($, cfg.zones, true, !e.isAborted && e.reason === 'answer')
      if (cfg.features.collision) await safeBeat($, { status: 'idle' })
    }
    const r = await next(e)
    // A-4.1: the turn's requests read or wrote the main cache, so its countdown restarts.
    // Guarded: this runs after next, and a throw here must not replay the turn's end.
    if (!e.agentId && r.usage && cfg.features.cache) {
      try { await noteResponse($, r.usage) } catch (err) { $.ui.log(`steward: cache note failed: ${String(err)}`, { to: 'debug' }) }
    }
    return r
  }).catch(($, e, next) => next(e))

  // A-2.6: watch finished tools for a task boundary (observe only; never blocks).
  // A-6.2 (PRD G-1): after a successful Edit, Write or NotebookEdit, record the file in
  // this session's registry entry (subagents' edits count as this session's).
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (cfg.features.context && !e.agentId) {
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      try { await noteTool($, cfg.zones, { tool, input, result: r.result, isOk: !r.deny && !r.isError }) }
      catch (err) { $.ui.log(`steward: boundary note failed: ${String(err)}`, { to: 'debug' }) }
    }
    if (cfg.features.collision && r.deny === undefined && !r.isError) {
      const path = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
      if (path) {
        try { await noteEdit($, normPath(await $.session.cwd(), path), cfg.collisionWindowMinutes * 60_000) }
        catch (err) { $.ui.log(`steward: registry write failed: ${String(err)}`, { to: 'debug' }) }
      }
    }
    return r
  }).catch(($, e, next) => next(e)) // after next every step is guarded, so this runs only if next threw

  // A-5.3 (PRD B-4): destructive Bash commands wait for Proceed / Cancel / Allow for session.
  // Any failure in the guard itself lets the command through (D-6), logged to debug.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!cfg.features.blast) return next(e)
    const v = await blastVerdict($, e.command, cfg.blastPatterns)
    return v.go ? next(e) : { deny: v.reason }
  }).catch(($, e, next) => {
    $.ui.log('steward: blast guard failed; command allowed', { to: 'debug' })
    return next(e)
  })

  // A-6.3 (PRD G-2, G-3): before an edit, ask when another live session edited the same
  // file within the window. A failure in the guard lets the edit through (D-6).
  const collisionWindowMs = cfg.collisionWindowMinutes * 60_000
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!cfg.features.collision) return next(e)
    const v = await collisionVerdict($, normPath(await $.session.cwd(), e.file_path), collisionWindowMs)
    return v.go ? next(e) : { deny: v.reason }
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!cfg.features.collision) return next(e)
    const v = await collisionVerdict($, normPath(await $.session.cwd(), e.file_path), collisionWindowMs)
    return v.go ? next(e) : { deny: v.reason }
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    if (!cfg.features.collision) return next(e)
    const v = await collisionVerdict($, normPath(await $.session.cwd(), e.notebook_path), collisionWindowMs)
    return v.go ? next(e) : { deny: v.reason }
  }).catch(($, e, next) => next(e))

  // A-2.4: a new main turn or typing in the prompt cancels a running countdown.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await cancelCountdown($, 'cancelled: a new turn started')
      await abortAutoWrite($, 'a new turn started')
      if (cfg.features.collision) await safeBeat($, { status: 'working' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    if (e.text.trim() !== '') {
      await cancelCountdown($, 'cancelled: you started typing')
      await abortAutoWrite($, 'you started typing')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A-3.3: Enter on an edited brief hands off with it instead of sending it here.
  on('prompt.submit', async ($, e, next) => {
    // The engine stamps every prompt's origin; the person's own Enter is `composer`
    // (`bridge` is the person too, from Remote Control). Notifications, peers,
    // plugins and the like are not the person's task.
    const kind = e.origin?.kind
    const byPerson = (kind === 'composer' || kind === 'bridge') && !e.isMeta
    const drop = await catchEditedBrief($, e.text, kind === 'composer')
    if (drop) return { drop }
    // A-6.5: what this session is doing, for other sessions' dialogs (not slash commands).
    if (cfg.features.collision && byPerson && !e.text.trimStart().startsWith('/')) await safeBeat($, { status: 'working', task: e.text })
    return next(e)
  }).catch(($, e, next) => next(e))

  // A-3.3: a /clear ends this session; refill the fresh one's prompt box from a timer.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetCache($)
      scheduleReseed($)
    }
    // A-6.5: other sessions stop asking about this one at once.
    if (cfg.features.collision) try { await endHeartbeat($) } catch (err) { $.ui.log(`steward: heartbeat end failed: ${String(err)}`, { to: 'debug' }) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    await setPaneUp($, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'steward' }, async ($, e) => {
    // The engine already prefixes replies with "steward:"; drop our own toast prefix.
    const r = await stewardCommand($, e.args, cfg)
    return { text: r.replace(/^Steward: /, '') }
  })

  // ───────── Surface B: the cockpit pane (primary) ─────────
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const s = await snapshot($, cfg)
    const f = cfg.features
    const w = Math.max(8, Math.min(24, e.props.bodyColumns - 12))
    const now = await $.clock.now()
    const ago = (t: number) => {
      const m = Math.max(0, Math.round((now - t) / 60_000))
      return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
    }

    const act = (key: string, hotkey: string, label: string, id: Parameters<typeof runAction>[1]) => (
      <Button key={key} hotkey={hotkey} plain onPress={() => runAction($, id)}>{label}</Button>
    )
    const section = (id: SectionId, body: () => RenderChildren) => {
      const meta = SECTIONS.find(x => x.id === id)
      if (!meta) return null
      const isOpen = !s.collapsed.includes(id)
      return (
        <Box flexDirection="column">
          <Button key={`sec-${id}`} hotkey={meta.hotkey} plain onPress={() => toggleSection($, id)}>
            {`${isOpen ? '▾' : '▸'} ${meta.title}`}
          </Button>
          {isOpen && body()}
        </Box>
      )
    }

    const u = s.live
    return (
      <Box flexDirection="column" gap={1}>
        {s.demo !== 'off' && <Text color="suggestion">DEMO: {s.demo} · /steward demo off</Text>}

        {f.context && section('context', () => (
          <Box flexDirection="column">
            <Text color={ZONE_COLOR[s.zone.zone]}>{bar(s.pct, w)} {s.pct}%  {s.zone.zone.toUpperCase()}</Text>
            <Text dimColor>{s.tokensText} tokens</Text>
            {s.boundary && (
              <Box gap={2}>
                <Text color="success">✓ {s.boundary.why}: good moment to hand off</Text>
                <Button key="a-bdismiss" hotkey="x" plain onPress={() => dismissBoundary($)}>dismiss</Button>
              </Box>
            )}
            {s.handoff.phase === 'countdown' && (
              <Box gap={2}>
                <Text color="suggestion">↻ auto-handoff in {s.handoff.secondsLeft}s …</Text>
                <Button key="a-cancel" hotkey="c" plain onPress={() => runAction($, 'cancel')}>cancel</Button>
              </Box>
            )}
            <Text dimColor>amber {shortTokens(s.zone.amberAt)} · red {shortTokens(s.zone.redAt)}{` · auto-compact ${u.autoCompactAt ? shortTokens(u.autoCompactAt) : 'off'}`}</Text>
            <Box gap={2}>{act('a-handoff', 'h', 'handoff', 'handoff')}{act('a-fresh', 'f', 'fresh', 'fresh')}{act('a-auto', 'a', s.auto.on ? `auto on @${shortTokens(s.auto.atTokens ?? s.zone.redAt)}` : 'auto off', 'auto')}<Button key="a-off" hotkey="o" plain onPress={() => markOff($, cfg.zones)}>seems off</Button></Box>
            {s.marks.length > 0 && <Text dimColor>off marks: {s.marks.length}{s.marks.slice(-3).reverse().map(m => ` · ${shortTokens(m.tokens)} t${m.turn} ${ago(m.at)}`).join('')}</Text>}
          </Box>
        ))}

        {f.cache && section('cache', () => (
          <Box flexDirection="column">
            <Text color={s.cache.isCold ? 'warning' : s.cache.minutesLeft !== null && s.cache.minutesLeft <= 5 ? 'warning' : undefined}>
              {s.cache.isCold
                ? `❄ cold (est.)${s.cache.lastAt !== null ? `, since ${ago(s.cache.lastAt + s.cache.ttlMinutes * 60_000)}` : ''}`
                : s.cache.minutesLeft !== null ? `⏱ cold in ${leftText(s.cache)} (est.)` : '– no reply yet this session'}
            </Text>
            {s.cache.hit && (
              <Text dimColor>
                last turn: <Text color={s.cache.hit.isHit ? 'success' : 'warning'}>{s.cache.hit.isHit ? 'hit ✓' : 'miss ✗'}</Text> {shortTokens(s.cache.hit.read)} read · {shortTokens(s.cache.hit.written)} written
              </Text>
            )}
            {isFreeHandoff(s.zone.zone, s.cache) && <Text color="success">→ {FREE_HANDOFF_TEXT}: h in Context</Text>}
            {s.coldUsd !== null && (
              <Text dimColor>next msg ≈ {usdText(s.coldUsd)}{s.cache.isCold ? '' : ' if cold'} (est., {s.cache.ttlMinutes > 5 ? '1h' : '5m'} write rate)</Text>
            )}
            <Text dimColor>window {s.cache.ttlMinutes}m (est.)</Text>
            <Box gap={2}>
              {act('a-warm', 'k', 'keep warm', 'warm')}
              <Button key="a-ttl" hotkey="t" plain onPress={() => fillCommand($, '/steward ttl ')}>window…</Button>
            </Box>
          </Box>
        ))}

        {f.usage && section('usage', () => (
          <Box flexDirection="column">
            <Text>5h  {u.fiveHour === null ? 'n/a' : `${bar(u.fiveHour, w)} ${u.fiveHour}%`}</Text>
            {resetIn(u.fiveHourResets, now) && <Text dimColor>    {resetIn(u.fiveHourResets, now)}</Text>}
            <Text>wk  {u.week === null ? 'n/a' : `${bar(u.week, w)} ${u.week}%`}</Text>
            {resetIn(u.weekResets, now) && <Text dimColor>    {resetIn(u.weekResets, now)}</Text>}
            <Text dimColor>session {u.usd === null ? 'n/a' : `$${u.usd.toFixed(2)}`}</Text>
          </Box>
        ))}

        {f.collision && section('sessions', () => (
          <Box flexDirection="column">
            {s.others.length === 0
              ? <Text dimColor>only this session</Text>
              : s.others.map(o => (
                <Box flexDirection="column">
                  <Text color="suggestion">◆ "{o.task}" · {o.status}</Text>
                  {o.files.slice(0, 3).map(file => <Text dimColor>   {file}</Text>)}
                </Box>
              ))}
          </Box>
        ))}

        {(f.collision || f.blast) && section('guards', () => {
          const n = (o: GuardEvent['outcome']) => s.guards.filter(g => g.outcome === o).length
          const MARK = { blocked: ['✕', 'error'], proceeded: ['✓', 'success'], allowed: ['↷', undefined] } as const
          return (
            <Box flexDirection="column">
              <Text>blast {f.blast ? '✓' : '–'}  collision {f.collision ? '✓' : '–'}{f.collision && <Text dimColor> (Phase 6)</Text>}</Text>
              {s.guards.length === 0
                ? <Text dimColor>nothing guarded yet this session</Text>
                : <Text dimColor>{n('blocked')} blocked · {n('proceeded')} proceeded · {n('allowed')} allowed</Text>}
              {s.guards.slice(-3).reverse().map((g, i) => (
                <Text key={`g-${i}`}><Text color={MARK[g.outcome][1]}>{MARK[g.outcome][0]}</Text> <Text dimColor>{g.target.length > w + 12 ? `${g.target.slice(0, w + 11)}…` : g.target} · {ago(g.at)}</Text></Text>
              ))}
              <Box>
                <Text dimColor>allow list: {s.allowSaved.length} saved{s.allowSession.length ? ` · ${s.allowSession.length} this session` : ''}  </Text>
                <Button key="g-allow" hotkey="l" plain onPress={() => fillCommand($, '/steward allow')}>list</Button>
              </Box>
            </Box>
          )
        })}

        {section('handoffs', () => (
          <Box flexDirection="column">
            {s.briefs.list.length === 0
              ? <Text dimColor>none yet · h writes one</Text>
              : <Text dimColor>{s.briefs.week} handoff{s.briefs.week === 1 ? '' : 's'} this week · click to open</Text>}
            {s.briefs.list.map(b => (
              <Box key={b.name} gap={1}>
                <Link href={`file://${b.path}`}>{b.preview ? 'preview' : 'brief'} {new Date(b.at).toTimeString().slice(0, 5)}</Link>
                <Text dimColor>{ago(b.at)}</Text>
              </Box>
            ))}
          </Box>
        ))}

        {section('commands', () => (
          <Box flexDirection="column">
            <Text dimColor>click one to put it in the prompt, then esc · enter</Text>
            {COMMANDS.map(([cmd, what]) => (
              <Box key={`c-${cmd}`} flexDirection="column">
                <Button key={`cmd-${cmd}`} plain onPress={() => fillCommand($, cmd)}>{cmd.trimEnd()}{cmd.endsWith(' ') ? ' …' : ''}</Button>
                <Text dimColor>   {what}</Text>
              </Box>
            ))}
          </Box>
        ))}

        <Text dimColor>{e.props.isFocused ? 'h f a o k c x: actions · 1–7: fold sections · esc: prompt' : 'ctrl+x tab or click to use keys'}</Text>
      </Box>
    )
  })

  // ───────── Surface A: the band (fallback, and alerts) ─────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await snapshot($, cfg)
    const f = cfg.features
    const view = resolveBand({
      zone: f.context ? s.zone.zone : 'green',
      pct: s.pct,
      tokensText: s.tokensText,
      cache: f.cache ? { minutesLeft: s.cache.minutesLeft, isCold: s.cache.isCold, coldUsd: s.coldUsd } : null,
      handoff: s.handoff.phase,
      countdownSeconds: s.handoff.phase === 'countdown' ? s.handoff.secondsLeft : 0,
      others: { count: f.collision ? s.others.length : 0, task: s.others[0]?.task ?? null },
      usage: f.usage ? { fiveHour: s.live.fiveHour, week: s.live.week, usd: s.live.usd } : null,
      paneUp: s.paneUp,
      quiet: cfg.quiet,
    })
    if (!view) return next(e)
    const v = fitBand(view, e.props.bodyColumns)
    const { Box, Button, Text } = $.ui.resolve(e)
    const behind = s.paneBehind && !s.paneUp && e.props.bodyColumns >= 60 ? 'Steward pane is behind another tab' : null
    const segs = [...v.segments.map(x => x.text), ...(behind ? [behind] : [])].join('  ·  ')
    return (
      <Box gap={2}>
        <Text color={TONE_COLOR[v.tone]} dimColor={v.tone === 'calm'}>
          {v.icon} {v.lead}{segs ? `  ·  ${segs}` : ''}{s.demo !== 'off' ? '  (DEMO)' : ''}
        </Text>
        {v.actions.map((a, i) => (
          <Button key={`b-${a.id}`} hotkey={a.id === 'pane' ? '9' : String(i + 1)} plain dimColor onPress={() => runAction($, a.id)}>
            {a.label}
          </Button>
        ))}
      </Box>
    )
  })
}
