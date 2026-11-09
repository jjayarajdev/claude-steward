# Plan: Steward

Companion to [PRD.md](PRD.md) and [DESIGN.md](DESIGN.md). The task breakdown is in [ACTIVITIES.md](ACTIVITIES.md).

## 1. Approach

Build **one plugin** that is risk-first and UI-shell-first:

1. Prove the three risky mechanics (clear + re-seed, keys on the band, dialog inside a tool hook).
2. Build the **shell** early: state atoms, HUD band and an empty pane. Every feature then plugs into a surface that already exists and can be seen working straight away.
3. Add feature modules one at a time. Each lights up a band state and a pane section.

```
Phase 0  Spikes & setup
   │
Phase 1  Shell: state atoms · HUD band (A) · pane skeleton (B) · keys · /steward · config
   │
   ├─> Phase 2  Usage + Context (no risk, fills band immediately)
   ├─> Phase 3  Handoff  ──> wires H / F / auto-handoff
   ├─> Phase 4  Cache
   ├─> Phase 5  Blast
   └─> Phase 6  Collision
                 │
Phase 7  Hardening, install, soak, (optional) share
```
Phases 4–6 are independent of each other once Phase 1 is done.

## 2. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| D-1 | **One plugin, internal modules** (`hooks/<feature>.ts`), each switched on or off by its own `userConfig` toggle | One install, one config section, one command (G5), without losing modularity |
| D-2 | **Two surfaces only**: an AbovePrompt band (A) and an opt-in Pane (B), plus engine dialogs and notifications | Solves the "too many things to watch" problem |
| D-3 | **Event hooks write atoms; render only reads atoms** (`hooks/state.ts`) | No I/O in render, and both surfaces stay consistent |
| D-4 | **Band priority resolver** is a pure function from state to the band model, unit-tested | Most of the band's logic can be tested without a UI |
| D-5 | **Keys: empty prompt or leader chord**, and every key has a button and a command | Avoids accidental triggers while typing (R6) |
| D-6 | **Per-module error isolation**: each module's hooks are wrapped, and a failure logs and falls through to `next(e)` | One bug never takes down the others (R7) |
| D-7 | **Collision registry**: one JSON file per session under `~/.claude/steward/registry/`, merged on read, stale after 2 minutes | No locking primitive is available (R3) |
| D-8 | **Cache TTL is an estimate**, labelled "est." | The API does not expose it |
| D-9 | **Dev location**: `~/.claude/dev-mods/<session>/steward/` with hot reload. Source mirrored to `mymod/steward/`. Installed at user scope | Hot reload while building, plus a durable source copy |

## 3. Phases and milestones

| Phase | Scope | Exit criteria | Est. |
|---|---|---|---|
| **0. Spikes & setup** | Layout, tsconfig, check script. Spikes: clear + re-seed, band keys and leader chord, ask inside `tool.call` | Every spike has a yes/no answer and a chosen approach. R1 and R6 resolved | 1 day |
| **1. Shell** | Atoms, band priority resolver, band render with width logic, pane skeleton, keys, `/steward` router, userConfig | The band shows placeholder states. The pane toggles. Keys and buttons route to stub actions | 1.5 days |
| **2. Usage + Context** | `session.measure` → atoms, zones, toasts, auto-handoff arming (stub action) | The band shows live ctx and limits that match `/context` and the status line | 0.75 day |
| **3. Handoff** | Brief, confirm, persist, clear, re-seed, `fresh`, auto mode, band progress states | Round trip works 5 out of 5 times on a 100K+ token session | 1.5 days |
| **4. Cache** | Countdown, notify, cold cost, keep-warm, cache-hit check | Notification arrives on time (S-5). Band and pane are correct | 1 day |
| **5. Blast** | Tokenized matcher, impact preview, dialog, allowlist, guard stats | S-4 passes. 20+ matcher tests are green | 1.5 days |
| **6. Collision** | Registry, pre-edit check, dialog, heartbeat, ◆ indicator, Sessions section | S-1 and S-2 pass | 1.5 days |
| **7. Hardening & release** | Full test pass, degradation on other surfaces, README, install, soak | Installed at user scope. One week of use with no blocking bugs | 1 day + 1 week soak |

**Total build effort:** about 9–10 working days, plus a one-week soak.

## 4. Testing strategy
- **Unit** (`claude plugin test`): band priority resolver, width dropping, zone maths, TTL countdown and re-arming, Blast tokenizer and matcher, registry merge and expiry, deny messages, brief template.
- **Static:** `claude plugin validate` and `tsc -p` on every change.
- **Manual scenarios** S-1 to S-6 (in ACTIVITIES.md).
- **Soak:** one week of daily use with a log of false positives, misses and annoyances.

## 5. Release and distribution
1. Install at **user scope**.
2. Optional: a **private** GitHub marketplace repo after a secret and internal-URL scan, so teammates can run `/plugin install steward --marketplace <owner>/<repo>`.
3. Semver and a changelog.

## 6. Dependencies and assumptions
- Claude Code 2.1.319 or later, with mod hot reload enabled for development.
- A subscription account for the rate-limit display (hidden otherwise).
- Native notifications set up (`preferredNotifChannel`).
- A git repo for the worktree option and the Blast git previews.

## 7. Decisions needed
- Before **Phase 1**: **Q3** (leader chord).
- Before **Phase 3**: **Q2** (fill or auto-submit).
- Before **Phase 5**: **Q1** (reuse filetree code or write fresh).
- The others can use the proposed defaults.
