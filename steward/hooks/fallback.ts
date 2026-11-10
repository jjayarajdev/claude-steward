// A-7.3 (NFR): on surfaces that draw no band (VS Code, mobile), and while the
// Steward pane isn't showing, the band's text goes to Steward's status line.
// The terminal and the desktop app draw the band, so the line stays empty there.
import type { EngineInterface } from 'claude-code'

import { resolveBand, statusLine } from './core/band'
import { bandInputOf, snapshot } from './view'
import type { Config } from './view'

const BANDLESS = new Set(['vscode', 'mobile'])
let last: string | undefined

/** Called on the 5 s pane check; writes only when the text changes. */
export async function syncStatus($: EngineInterface, cfg: Config): Promise<void> {
  const surfaces = await $.session.surfaces()
  const s = await snapshot($, cfg)
  let text: string | undefined
  if (surfaces.some(x => BANDLESS.has(x)) && !s.paneUp) {
    const v = resolveBand(bandInputOf(s, cfg))
    text = v ? statusLine(v) : undefined
  }
  if (text !== last) {
    last = text
    $.ui.status(text)
  }
}
