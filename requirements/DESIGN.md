# Design: Steward

Companion to [PRD.md](PRD.md). Chosen direction (revised 2026-11-09): **pane-first**. The **cockpit pane (B) is the primary home** for everything, and it opens at session start. The **band (A) is a fallback**: it shows only while the pane is closed or not placed (the engine seats an unasked pane only on terminals 144+ columns wide), or for a level-1/2 alert. The owner wants as much as possible in the side pane.
Not chosen: a filetree fork (C), deferred. See PRD §10.

---

## 1. Principle: glance, don't watch

Steward is **one mod** with **one line** on screen. Everything is always on. The user never has to "open" a feature to be protected by it. Attention goes up the ladder only as far as the situation needs:

| Level | Trigger | Surface | Blocks? |
|---|---|---|---|
| 0 Calm | Everything fine | Dim HUD line above the prompt | No |
| 1 Heads-up | Context amber or red, cache < 10 min, other session active | HUD line changes colour, icon and action keys | No |
| 2 Away | Cache cold in ≤ 5 min, auto-handoff armed, Claude finished a turn (optional) | Native notification (`$.ui.notify`) + optional sound, toast fallback | No |
| 3 Decision | Destructive command, cross-session edit collision | Engine's own question dialog (`$.ui.ask`) | **Yes**, until the user chooses |

Rule: **a level-3 dialog is the only thing that can stop work.** Levels 0–2 never take the keyboard.

---

## 2. Surface A: HUD band (always on)

One line, drawn by `ui.render` on `AbovePrompt`. Width-aware: segments drop from the right as the terminal narrows (see §2.3).

### 2.1 States

**Calm**
```
 ● ctx 31% ▓▓▓░░░░░░░  ·  cache 52m  ·  5h 18%  wk 9%  ·  $2.40  ·  ◇ 1 other session
```

**Context amber** (default `min(250K, 50% of window)`, see PRD C-2)
```
 ▲ ctx 46% ▓▓▓▓▓░░░░░  quality may drop   [H] handoff → new   [F] fresh   [A] auto: off
```

**Context red** (default `min(400K, 80% of auto-compact threshold)`, always before the engine's auto-compact)
```
 ■ ctx 53% ▓▓▓▓▓▓░░░░  hand off now        [H] handoff → new   [F] fresh   [A] auto: off
```

**Cache warning** (< 10 min; a native notification is also sent at ≤ 5 min)
```
 ⏱ cache cold in 4m (est.)  next msg ≈ $1.90 uncached   [K] keep warm   [H] handoff & clear
```

**Cache cold**
```
 ❄ cache cold (est.)  next msg ≈ $1.90   [H] handoff & clear   ·  ctx 31%
```

**Auto-handoff countdown**
```
 ↻ auto-handoff at 50% in 10s …   1: cancel
```

**Other session active**
```
 ● ctx 31% · cache 52m · ◆ other session: "add Most Popular badge" — working · 2 files   [S] details
```

**Handoff in progress / arrived**
```
 ↻ writing handoff brief …
 ✓ handoff arrived — brief is in the prompt box, review and send
```

### 2.2 Priority when several apply
The band shows the highest-priority state. Lower-priority segments shrink into the trailing summary.

1. Auto-handoff countdown / handoff in progress
2. Cache cold in ≤ 5 min
3. Context red
4. Cache cold
5. Context amber
6. Cache < 10 min
7. Other session active
8. Calm

### 2.3 Narrow terminals
Segments drop in this order as width shrinks: cost → weekly limit → 5h limit → other-session text (the ◆ icon stays) → cache minutes (the icon stays). Context % never drops. Under 40 columns, Steward falls back to `$.ui.status` (the status line).

### 2.4 Action keys (revised after spike A-0.3)
Typing in the prompt must never trigger an action by accident. The engine handles this natively through Button `hotkey`:
- A **digit** (`1`–`9`) presses a band button **only from an empty prompt**. While you type, digits go into the text. This was checked live.
- **Letters** work only after the band has focus (`ctrl+x tab` or a click).
- No leader chord is needed, so Q3 is closed.

Digits are **per state**: `1` is always the main action of the current state. Mockups in §2.1 that show `[H]`/`[F]`/`[K]` should be read as `1`/`2`/`3`. Every action is also a **clickable button**, and a `/steward` subcommand.

| State | 1 | 2 | 3 |
|---|---|---|---|
| Context amber/red | handoff → new (`/steward handoff`) | fresh (`/steward fresh`) | auto on/off (`/steward auto`) |
| Cache warning/cold | keep warm (`/steward ping`) | handoff & clear | – |
| Auto-handoff countdown | cancel (`/steward cancel`) | – | – |
| Other session active | details (opens pane) | – | – |
| Any (band focused) | letter `s` toggles the cockpit pane (`/steward`) | | |

> Note on K: "keep warm" costs one small turn. It is never automatic and always user-initiated.

### 2.5 Colour
The band uses terminal palette colours and `dimColor`, so the user's theme owns them: green/dim for calm, yellow for amber, red for red, cyan for informational states. Every state also has a distinct icon (● ▲ ■ ⏱ ❄ ↻ ✓ ◆), so it can be read without colour.

---

## 3. Surface B: Cockpit pane (opt-in)

Opened with `S`, a click on the band, or `/steward`. Drawn by `$.ui.open({ id: 'steward', title: 'Steward' })` + `ui.render` on `Pane`. It never opens by itself. When the user opens it, it seats at any width. The band stays visible while the pane is open.

```
┌ Steward ──────────────────────── ✕ ┐
│ CONTEXT        46%  ▓▓▓▓▓░░░░░     │
│   230K / 500K    zone: AMBER       │
│   amber 250K · red 400K · ac 800K  │
│   auto-handoff  50%   [on]         │
│   [H] handoff   [F] fresh          │
│                                    │
│ CACHE          cold in 41m (est.)  │
│   last reply 09:14 · ttl 60m       │
│   last turn cache hit ✓ 228K read  │
│   next msg if cold ≈ $1.90         │
│   [K] keep warm   [T] ttl…         │
│                                    │
│ USAGE  5h ▓▓░░░░ 18%  resets 13:00 │
│        wk ▓░░░░░  9%  resets Mon   │
│        session $2.40               │
│                                    │
│ SESSIONS HERE                      │
│   ◆ #2 "pricing badge"   working   │
│       src/pricing.html   3m ago    │
│       src/styles.css     5m ago    │
│                                    │
│ GUARDS   blast ✓   collision ✓     │
│   today  2 blocked · 1 proceeded   │
│   last   rm -rf build/  ✕ cancel   │
│                                    │
│ HANDOFFS  3 this week              │
│   09:02  "steward PRD"  [open]     │
└────────────────────────────────────┘
```

Sections can be collapsed and the state is remembered. Each feature can be disabled in `/config`, and a disabled feature's section is hidden.

---

## 4. Level-3 dialogs (engine question dialog)

The engine's own `AskUserQuestion` dialog is used through `$.ui.ask`, so there is no new UI to learn and it works on every surface.

**Collision Guard**
```
 ┌ Collision Guard ──────────────────────────────────────────────┐
 │ src/pricing.html was edited 3 min ago by another session       │
 │ ("change Pro price $29 → $39"). How should I proceed?          │
 │  ❯ Proceed      Move to worktree      Cancel      Other…       │
 └───────────────────────────────────────────────────────────────┘
```

**Blast Radius**
```
 ┌ Blast Radius ─────────────────────────────────────────────────┐
 │ rm -rf build/  →  deletes 214 files, 38 MB                     │
 │   build/app.js · build/assets/ (201) · build/index.html …      │
 │ Proceed?                                                       │
 │  ❯ Proceed      Cancel      Allow this pattern for session     │
 └───────────────────────────────────────────────────────────────┘
```

**Handoff confirm**
```
 ┌ Handoff ──────────────────────────────────────────────────────┐
 │ Brief ready (1.4K tokens): goal, 6 decisions, 3 open tasks.    │
 │ Clear this session and start fresh with it?                    │
 │  ❯ Proceed      Edit brief first      Cancel                   │
 └───────────────────────────────────────────────────────────────┘
```

---

## 5. Commands and configuration

One command, `/steward [sub]`:

| Sub | Effect |
|---|---|
| *(none)* | Toggle cockpit pane |
| `handoff` / `fresh` | Handoff / clean clear |
| `auto [here] on\|off\|<tokens>`, `auto here reset` | Auto-handoff (user default, or this project with `here`) |
| `ttl <min>` | Cache window estimate |
| `ping` | Keep cache warm |
| `cancel` | Cancel pending auto-handoff |
| `quiet on\|off` | Hide calm band (shows only at level ≥ 1) |
| `allow <pattern>` | Add Blast Radius allowlist entry |
| `status` | Print a text summary to the transcript |

One `/config` section with toggles for each feature (context, cache, usage, collision, blast, sound) plus thresholds, TTL, leader key and pricing.

---

## 6. Internal module layout

```
steward/
  .claude-plugin/plugin.json      one plugin, one userConfig section
  types/index.d.ts                $.state contract (all atoms)
  hooks/hooks.json
  hooks/register.tsx              wires modules, honours feature toggles
  hooks/state.ts                  atoms: context, cache, usage, sessions, guards, handoff
  hooks/hud.tsx                   band render + priority + width logic   (Surface A)
  hooks/pane.tsx                  cockpit render                         (Surface B)
  hooks/keys.ts                   empty-prompt keys + leader chord
  hooks/handoff.ts                brief → persist → clear → re-seed
  hooks/context.ts                zones, auto-handoff arming
  hooks/cache.ts                  countdown, notify, cold-cost estimate
  hooks/collision.ts              registry, pre-edit ask, heartbeat
  hooks/blast.ts                  destructive-command gate + impact preview
  tests/*.test.ts
```

Data flow: **event hooks write atoms → hud/pane only read atoms** (no I/O in render).

```
session.measure ─┐
turn.complete  ──┤                 ┌─> hud.tsx  (AbovePrompt)
prompt.submit  ──┼─> state atoms ──┤
clock timers   ──┤                 └─> pane.tsx (Pane)
registry files ──┘
tool.call (Edit/Write/Bash) ─> collision.ts / blast.ts ─> $.ui.ask ─> allow | deny
```
