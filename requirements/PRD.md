# PRD: Steward, one Claude Code mod for session safety and context

| | |
|---|---|
| **Author** | Jay Jayakeerthy |
| **Date** | 2026-11-09 |
| **Status** | Draft v0.3: Phase 0 spike results recorded |
| **Source** | "9 Claude Code Mods You NEED to Install Right Now" (Claude Mod.pdf), plus a check against the mod API (Claude Code 2.1.319) |
| **Design** | [DESIGN.md](DESIGN.md) |

### Change log
- **v0.3 (2026-11-09):** Phase 0 spike results (A-0.2, A-0.3, A-0.4, A-0.6, A-0.7) recorded in §8 and §9. Pane-first: the pane is the primary surface and the band is a fallback or alert line.
- **v0.2 (2026-11-09):** Five separate mods merged into **one mod, Steward**, with one HUD band (A) and an opt-in cockpit pane (B). Blast Radius is now built in instead of the official plugin being adopted. The filetree fork (C) is deferred.
- v0.1 (2026-11-09): Initial suite of five mods.

---

## 1. Problem

Claude Code is used in long sessions, and often in several sessions at once. Four problems keep coming up:

1. **Context decay without a decision.** The context % says how full the window is, but not what to do. Writing a handoff by hand takes four steps.
2. **Silent cache expiry.** After a break, the next message re-sends the whole conversation without the cache, with no warning.
3. **Cross-session edit collisions.** Two sessions edit the same file without knowing about each other.
4. **Destructive commands.** `rm -rf`, force-push and `reset --hard` can run without a readable "what will be lost" confirmation.

Plus a meta-problem the user raised: **several separate mods means several things to open and watch.** A solution must put everything in one place and stay quiet until it matters.

## 2. Goals and non-goals

### Goals
- G1: Turn context fill into a **one-keystroke decision** (handoff, fresh start, or keep going).
- G2: Make **cache state visible** and warn before it goes cold.
- G3: **Detect and resolve** cross-session edits to the same file.
- G4: Put a **Proceed/Cancel gate with an impact preview** in front of destructive operations.
- G5: **One mod, one line on screen, one command, one config section.** Nothing has to be opened to be protected.
- G6: Make no model calls except for handoff-brief generation.

### Non-goals
- No changes to `/compact` or auto-compact.
- No model routing or budget caps in v1.
- No cross-machine or cloud-session collision detection.
- No remote telemetry or network use.
- No filetree integration in v1 (Design C is deferred).

## 3. Users
- **Primary:** a solo developer running one to several local terminal sessions in long sessions.
- **Secondary:** a team sharing Steward through project scope or a private GitHub marketplace.

## 4. Product shape

**Steward** is a single plugin made of internal feature modules. The user sees:

| Surface | What it is | When |
|---|---|---|
| **A: HUD band** | One line above the prompt | Always (can be hidden while calm with `quiet`) |
| **B: Cockpit pane** | Side pane with full detail | Only when the user opens it (`S` / `/steward`) |
| **Dialogs** | The engine's own question dialog | Only for level-3 decisions (collision, destructive, handoff confirm) |
| **Notifications** | Native notification, sound, toast fallback | Level-2 events (cache about to go cold, auto-handoff armed) |

Feature modules, each of which can be switched off in `/config`:

| Module | Purpose | Model calls? |
|---|---|---|
| handoff | Brief → persist → clear → re-seed | Yes, one per handoff |
| context | Zones, actions, auto-handoff | No |
| cache | Countdown, warning, cold-cost estimate | No |
| usage | Rate limits, session cost | No |
| collision | Cross-session pre-edit check, session awareness | No |
| blast | Destructive-command gate | No |

## 5. Functional requirements

Priority: **P0** must have for v1 · **P1** should have · **P2** nice to have.

### 5.A HUD band (Surface A)
| ID | Requirement | Pri |
|---|---|---|
| U-1 | A single AbovePrompt line shows context %, a bar, cache minutes, 5h/weekly %, session cost and the other-session indicator. | P0 |
| U-2 | Shows the highest-priority state per DESIGN §2.2. Lower-priority information shrinks into a trailing summary. | P0 |
| U-3 | Width-aware: segments drop in the DESIGN §2.3 order. Under 40 columns, falls back to the status line. | P0 |
| U-4 | Each state has a distinct icon as well as a colour (readable without colour). Uses theme palette colours only. | P0 |
| U-5 | Action keys are band Button **digit hotkeys**, which work only from an **empty prompt** (engine-native, checked in spike A-0.3). Letters work only once the band has focus. Every action is also a clickable button and a `/steward` subcommand. | P0 |
| U-6 | `quiet` mode hides the band while calm (level 0). | P1 |
| U-7 | Rendering does no I/O. It reads state atoms only. | P0 |

### 5.B Cockpit pane (Surface B)
| ID | Requirement | Pri |
|---|---|---|
| P-1 | `/steward` with no arguments, `S`, or a click on the band toggles the pane. It never opens by itself. | P0 |
| P-2 | Sections: Context, Cache, Usage, Sessions here, Guards (today's counts and last event), Handoffs (recent briefs with an open link). | P0 |
| P-3 | Sections can be collapsed and their state survives across sessions (`$.store`). Disabled features hide their section. | P1 |
| P-4 | The pane offers the same actions as the band (H, F, A, K, TTL edit). | P1 |

### 5.0 Handoff
| ID | Requirement | Pri |
|---|---|---|
| H-1 | `/steward handoff` generates a brief with `$.model.fork` (it reads the session's transcript through the prompt cache) covering the goal, decisions, current state, open tasks, key files and next step. The brief **must include ground truth beyond the conversation**: activity/task statuses, files changed recently, `git status`. It **must end with an instruction to confirm the state and plan with the user before changing anything**. *(From spike A-0.2: a brief built from the conversation alone was out of date, and the fresh session acted on it at once.)* | P0 |
| H-2 | Confirm dialog: Proceed / Edit brief first / Cancel. Auto mode skips it (see C-6). | P0 |
| H-3 | Saves the brief to `$.store` **before** clearing, runs `/clear`, then fills the brief into the fresh prompt box (default) or auto-submits it (option). | P0 |
| H-4 | Also writes the brief to `<project>/.claude/handoffs/<timestamp>.md`. | P1 |
| H-5 | `/steward fresh` runs a clean clear after confirmation. | P0 |
| H-6 | The brief model can be set (same as session / Sonnet / Haiku). | P1 |
| H-7 | The band shows "writing brief…" and then "handoff arrived". | P1 |

### 5.1 Context
| ID | Requirement | Pri |
|---|---|---|
| C-1 | Context fill comes from `session.measure` as %, tokens and window. | P0 |
| C-2 | Zones are set in **tokens**, not %: **Amber** at `min(250K, 50% of window)` and **Red** at `min(400K, 80% of autoCompactThreshold)` (falling back to 80% of window when auto-compact is off). Both are configurable. With a 1M window that's amber 250K, red 400K. With a 200K window, amber 100K, and red sits safely before auto-compact. *Rationale: quality loss tracks tokens and clutter, not window %. Red must always arrive before the engine's own lossy auto-compact.* | P0 |
| C-8 | **Task-boundary prompt:** in Amber or above, when a task looks finished (a `git commit` ran, or every task in Claude's task list is done), the pane suggests "Good moment to hand off" once. | P1 |
| C-9 | **Free-handoff moment:** when the cache is cold (K-8) and context is Amber or above, the pane and band say "cache is cold, so handing off now costs nothing extra". | P1 |
| C-10 | **Calibration:** a pane button "Claude seems off" records `{tokens, window, turn, time}` in `$.store`. After the soak, the defaults are re-set from these marks. | P1 |
| C-11 | Context composition: the pane shows the `/context` category split from `usage({breakdown:'summary'})`, which is a free local estimate. Clutter heuristics come later, once real data shows what helps. | P2 |
| C-3 | In Amber or Red, the band shows **[H] handoff → new** and **[F] fresh**. | P0 |
| C-5 | `/steward auto on|off|<tokens>` sets auto-handoff, saved per user; `/steward auto here …` sets a per-project override (`here reset` clears it). Without a token count it fires at the red zone. | P0 |
| C-6 | Auto-handoff fires **only between turns**, after a 10-second countdown on the band, plus a notification. Cancel: `1` in the band, `c` in the pane, `/steward cancel`, typing, or a new turn (the engine never delivers Esc to mods). A cancel holds it off for the rest of the session unless the auto setting changes. | P0 |
| C-7 | Toast once per zone change, not once per measurement. | P1 |

### 5.2 Cache
| ID | Requirement | Pri |
|---|---|---|
| K-1 | Countdown until the estimated cache expiry. Resets on each main-thread response. | P0 |
| K-2 | Window set with `/steward ttl <min>`, default 60. Labelled "est." because the API does not expose the real TTL. | P0 |
| K-3 | Native notification at ≤ 5 minutes (lead time configurable), falling back to a toast. | P0 |
| K-5 | Estimated cold-cache cost of the next message: context tokens × input price from a configurable pricing table, labelled as an estimate. | P1 |
| K-6 | **[H] handoff & clear** and **[K] keep warm** actions. Keep-warm is user-initiated only and never automatic. | P0 |
| K-8 | No countdown before the first response. Shows a "cold" state after expiry. | P0 |
| K-9 | The pane shows whether the last turn was a cache hit (`cache_read_input_tokens`), which helps check the TTL. | P1 |

### 5.3 Usage
| ID | Requirement | Pri |
|---|---|---|
| S-1 | 5h and weekly rate-limit % and reset times from `session.measure.rateLimits`. Hidden when not on a subscription. | P0 |
| S-2 | Session cost from `usage().cost`. Hidden when absent. | P0 |

### 5.4 Collision
| ID | Requirement | Pri |
|---|---|---|
| G-1 | Every session records `{sessionId, cwd, file, ts}` in a local registry after each successful Edit, Write or NotebookEdit. | P0 |
| G-2 | Before Edit, Write or NotebookEdit, checks whether **another** session touched the same absolute path within the window (default 30 minutes). | P0 |
| G-3 | On a hit, a dialog names the session's task and how long ago it edited the file: **Proceed / Move to worktree / Cancel / Other**. | P0 |
| G-4 | Proceed lets the call run. Cancel denies it with a reason the model reads. Worktree denies it and tells the model to EnterWorktree and retry. Other passes the user's text to the model as the reason. | P0 |
| G-5 | Heartbeat every 30 seconds with the task summary (last prompt, trimmed) and status (working / idle / ended). Older than 2 minutes counts as dead. | P1 |
| G-6 | Other live sessions in the same root appear as ◆ on the band and in the pane's Sessions section. | P1 |
| G-7 | No effect at all when only one session is open. | P0 |
| G-8 | Headless runs fail open and log the event. Fail-closed is an option. | P1 |

### 5.5 Blast
| ID | Requirement | Pri |
|---|---|---|
| B-1 | Gates Bash matching destructive patterns: `rm -r/-rf` and `rm` with globs, `git push --force/-f/--force-with-lease`, `git reset --hard`, `git clean -fd`, `git checkout -- .`/`git restore .`, `git branch -D`, `find … -delete`, plus user patterns. Commands are tokenized, not regex-matched on the raw string. | P0 |
| B-2 | Write over an existing file with large deletions, and batch overwrites of more than N files in a turn. | P1 |
| B-3 | Impact preview: files with count and size for rm, commits for reset or force-push, files for clean or restore. | P0 |
| B-4 | Proceed / Cancel / Allow this pattern for session. Nothing runs before the user chooses. | P0 |
| B-5 | Persistent allowlist through `/steward allow <pattern>` (e.g. `rm -rf node_modules`). | P1 |
| B-6 | Counts and the last event feed the pane's Guards section. | P1 |

## 6. Non-functional requirements
- **Performance:** `tool.call` checks add at most 50 ms at p95. Rendering does no I/O.
- **Cost:** no model calls except for handoff briefs and the user-initiated keep-warm ping.
- **Reliability:** every hook catches its errors, logs them to debug, and calls `next(e)` (fails open). Blast can be set to fail closed.
- **Privacy and security:** all state is local and there is no `$.http`. The registry stores paths and trimmed prompt summaries only. The code is small enough to review. Secrets are scanned before any sharing.
- **Surfaces:** the terminal comes first. Desktop and VS Code degrade to the status line and toasts where the band is not drawn.
- **Compatibility:** pinned to the mod API as of 2.1.319. Types are re-checked on each release.
- **Single install:** one plugin, one `/config` section, one `/steward` command.

## 7. Success metrics (self-measured, 4 weeks)
- At least 80% of sessions that reach the act threshold end in a handoff or fresh start.
- No lost work from collisions (self-report).
- Fewer than 1 Blast false positive per day after allowlist tuning.
- No cold-cache surprises without a prior warning.
- The pane is opened at most occasionally. The band alone should be enough day to day.

## 8. Feasibility: mod API mapping (verified against types, 2.1.319; Phase 0 spikes run live)

| Need | API | Notes |
|---|---|---|
| Context % and tokens | `session.measure`, `$.session.usage()` | Event-driven. `session.measure` fires only on change, so seed from `$.session.usage()` at start (found in Phase 1). Auto-compact point: `usage({breakdown:'summary'}).context.breakdown.autoCompactThreshold` |
| Rate limits | `session.measure.rateLimits[]` | Empty off a subscription |
| Session cost | `usage().cost` | May be absent |
| Band | `ui.render` on `AbovePrompt` | Surface A |
| Pane | `$.ui.open` + `ui.render` on `Pane` | Surface B, primary. **A-0.6 ✓** opens at session start on wide terminals, otherwise via `/steward`. **A-0.7:** skip `$.ui.open` when `$.session.surfaces()` is empty (`-p` logs `ui.open: no-surface`) |
| Buttons / keys | `Button` `hotkey` + `ui.press` | **A-0.3 ✓** engine-native: digit hotkeys fire only from an empty prompt; letter hotkeys only when the band or pane has focus (`ctrl+x tab` or click). No custom capture, no leader chord |
| Toast / notify / sound | `$.ui.toast`, `$.ui.notify`, `$.audio.play` | `notify` returns `isSent`, so a toast fallback is possible |
| Dialogs | `$.ui.ask` | **A-0.4 ✓** works inside `tool.call`: Proceed runs the tool; Cancel, Move to worktree and Other send the deny text to the model word for word. In `-p` it is unavailable and the guard fails open |
| Tool gating | `on('tool.call', {tool}, …)` | |
| Brief | `$.model.fork` (preferred) or `$.model.complete` over `$.session.messages()` | `fork` reuses the prompt cache, so it is cheaper. **A-0.8:** the brief only knows the conversation, so it must add ground truth (ACTIVITIES, changed files, git status) and end with "confirm with the user before changing anything" |
| Clear + re-seed | `$.command.run({command:'clear'})`, `$.prompt.fill` | **A-0.2 ✓ passed on attempt 1:** brief → `$.store` + `.claude/handoffs/*.md` → `/clear` → `session.end{reason:'clear'}` → `$.clock.after` → `$.prompt.fill`. Fill, never auto-submit (Q2) |
| Timers | `$.clock.every`, `$.clock.after` | |
| Shared registry | `$.fs` files under `~/.claude/steward/registry/` | One file per session, no locking needed |
| Persistent settings | `userConfig` + `$.store` | |
| Cache TTL | **Not exposed** | Estimated, labelled as such |

## 9. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| R1: ~~The `/clear` → re-seed sequence is unreliable~~ **Resolved by spike A-0.2 (passed on attempt 1)** | Handoff broken | Spike first. Fallback: the brief is saved to a file and the user pastes it into the new session |
| R2: The TTL estimate is wrong | Misleading countdown | "est." label, cache-hit check (K-9), adjustable TTL |
| R3: Registry write races | Lost entries | One file per session, merged on read |
| R4: Mod API changes | Breakage | Version pin, validate and tsc in CI, tests |
| R5: Dialog fatigue | User turns features off | Allowlists, "allow for session", quiet defaults. The dialog itself behaves correctly in all 5 cases (A-0.4) |
| R6: ~~Single-letter keys fire while typing~~ **Resolved by spike A-0.3** | Accidental handoff or clear | Engine-native hotkeys: band digits only from an empty prompt, letters only when focused. Destructive actions (F, H) always confirm |
| R7: One mod is a single point of failure | One bug affects every feature | Each module is isolated (every non-render hook ends `.catch(($,e,next)=>next(e))`) and can be switched off on its own |
| R8: Mods are unsandboxed | Security | Small code, no network, review before sharing |

## 10. Open questions
- ~~**Q1:** Reuse filetree's MIT guard and command-parsing code for Blast (with credit), or write it fresh?~~ **Closed 2026-11-09 (A-5.0): write fresh.** filetree `hooks/guard.ts` is a protected-folder guard for Edit/Write with plain substring mentions in commands (no tokenizer, no destructive patterns); `hooks/regex.ts` is a bounded regex engine for search, not needed because user and allow patterns are token patterns, not regexes. Nothing copied, so no credit needed.
- ~~**Q2:** fill or auto-submit~~ **Closed 2026-11-09:** fill. The live test showed why the user must review the brief before sending it.
- ~~**Q3:** Leader chord default~~ **Closed 2026-11-09:** not needed. Digit hotkeys only fire from an empty prompt (spike A-0.3).
- **Q4:** Install scope: user (proposed) or shared project?
- ~~**Q5:** Threshold defaults~~ **Closed 2026-11-09:** zones are in tokens, red is anchored before auto-compact, and the defaults are re-set from C-10 calibration marks after the soak. The model has no measured internal cliff, so these are heuristics to check against real data.
- **Q6:** Should Steward also play a sound when Claude finishes a turn (from the article's Plan Progress)? Proposed: off by default, toggle in config.
- **Deferred:** Design C, a Steward strip and collision markers inside filetree. Revisit after v1 soak.
