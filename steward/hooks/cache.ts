// A-4.1/4.2 prompt-cache countdown (PRD K-1, K-2, K-8, K-9).
// A main-thread reply restarts the estimate; a ticker redraws it (15 s, then 1 s
// in the last minute) and stops once cold. The TTL is the person's, kept in $.store.
import type { EngineInterface, Timer } from 'claude-code'

import { DEFAULT_LEAD_MINUTES, DEFAULT_TTL_MINUTES, countdown, hitOf, nextTickMs, parseTtl, warnAt, warnText } from './core/cache'
import { loadTtlSetting, patchCache, readCache, saveTtlSetting } from './state'

// Module variable: a reload starts it over, and session.start restarts the ticker.
let ticker: Timer | null = null

async function tick($: EngineInterface): Promise<void> {
  ticker = null
  const c = await readCache($)
  const v = countdown(c.lastAt, await $.clock.now(), c.ttlMinutes)
  await patchCache($, v)
  const ms = nextTickMs(v)
  if (ms !== null) ticker = $.clock.after(ms, () => { void tick($) })
}

// ── A-4.3 lead-time warning (K-3): one per idle stretch, re-armed by each reply ──
let warner: Timer | null = null
let leadMinutes = DEFAULT_LEAD_MINUTES
export const useCacheLead = (m: number): void => { leadMinutes = m }

async function armWarning($: EngineInterface): Promise<void> {
  warner?.cancel()
  warner = null
  const c = await readCache($)
  const at = warnAt(c.lastAt, c.ttlMinutes, leadMinutes)
  const now = await $.clock.now()
  // Already past the warning time (a reload late in the window): stay quiet.
  if (at === null || at <= now) return
  const lastAt = c.lastAt
  warner = $.clock.after(at - now, () => { void warn($, lastAt) })
}

async function warn($: EngineInterface, lastAt: number | null): Promise<void> {
  warner = null
  const c = await readCache($)
  if (c.lastAt !== lastAt || c.isCold) return // a reply came in since: it re-armed
  const v = countdown(c.lastAt, await $.clock.now(), c.ttlMinutes)
  if (v.minutesLeft === null) return
  const text = warnText(v.minutesLeft)
  const sent = await $.ui.notify(text, { title: 'Steward' })
  if (!sent.isSent) $.ui.toast(`Steward: ${text}`)
}

async function restart($: EngineInterface): Promise<void> {
  ticker?.cancel()
  await tick($)
  await armWarning($)
}

/** session.start (and every reload): the saved TTL, then resume any countdown. */
export async function startCache($: EngineInterface): Promise<void> {
  await patchCache($, { ttlMinutes: (await loadTtlSetting($)) ?? DEFAULT_TTL_MINUTES })
  await restart($)
}

/** A-4.1: a main-thread turn finished with usage, so the cache was just read or written. */
export async function noteResponse(
  $: EngineInterface,
  usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number },
): Promise<void> {
  await patchCache($, { lastAt: await $.clock.now(), hit: hitOf(usage) })
  await restart($)
}

/** A /clear starts a new conversation: its cache is cold and nothing has replied yet. */
export async function resetCache($: EngineInterface): Promise<void> {
  ticker?.cancel()
  ticker = null
  warner?.cancel()
  warner = null
  await patchCache($, { lastAt: null, hit: null, minutesLeft: null, secondsLeft: null, isCold: false })
}

/** `/steward ttl [<min>]`: show or set the estimate's window (saved for every session). */
export async function ttlCommand($: EngineInterface, arg: string | undefined): Promise<string> {
  const c = await readCache($)
  if (!arg) return `Cache window: ${c.ttlMinutes} min (est.). Set it with /steward ttl <minutes>.`
  const n = parseTtl(arg)
  if (typeof n === 'string') return n
  await saveTtlSetting($, n)
  await patchCache($, { ttlMinutes: n })
  await restart($)
  return `Cache window set to ${n} min (est.), for every session.`
}

// ── A-4.5 keep warm (K-6): user-initiated only, never automatic ──
// A fork re-reads the main conversation through the prompt cache, and a cache read
// restarts the entry's timer. Nothing joins the transcript. No `effort`, so the
// fork's request matches the main thread's and reads the cache as it stands.
const PING = 'Reply with exactly: ok'
let warming = false

export async function keepWarm($: EngineInterface): Promise<string> {
  const c = await readCache($)
  if (c.lastAt === null) return 'Nothing to keep warm yet: no reply in this session.'
  const v = countdown(c.lastAt, await $.clock.now(), c.ttlMinutes)
  if (v.isCold) return 'The cache is already cold (est.), so a ping would pay full price. Hand off (h) or just carry on.'
  if (warming) return 'Already keeping the cache warm.'
  warming = true
  $.clock.after(50, () => { void ping($) })
  return 'Keeping the cache warm (a few seconds; nothing is added to the conversation).'
}

async function ping($: EngineInterface): Promise<void> {
  try {
    const r = await $.model.fork({ prompt: PING })
    if (!r.isAnswered) {
      $.ui.toast(`Steward: keep-warm failed (${r.reason}).`)
      return
    }
    const read = r.usage.cache_read_input_tokens, wrote = r.usage.cache_creation_input_tokens
    await noteResponse($, r.usage)
    $.ui.toast(read >= wrote
      ? `Steward: ✓ cache kept warm (${Math.round(read / 1000)}K read from cache). Countdown restarted.`
      : `Steward: the cache had already expired; the ping wrote it again (${Math.round(wrote / 1000)}K). Countdown restarted.`)
  } catch (err) {
    $.ui.toast(`Steward: keep-warm failed (${String(err)}).`)
  } finally {
    warming = false
  }
}
