# Steward

One cockpit for Claude Code sessions. Steward is a Claude Code mod that keeps a side pane (with a band above the prompt as the fallback) showing:

- **Context health**: token zones (green / amber / red) against the auto-compact point, and a handoff before the context fills.
- **Handoff**: writes a short brief of the session (goal, decisions, current state, open tasks, next step), clears, and refills the fresh session's prompt with it. Briefs are kept in `.claude/handoffs/`.
- **Cache keeper**: an estimated prompt-cache countdown, a warning before it goes cold, the cost of the next message, and an optional keep-warm ping.
- **Usage**: 5-hour and weekly limits with reset times.
- **Blast radius**: before Claude runs a destructive shell or git command (`rm -rf`, `git reset --hard`, `git push --force`, `git clean -f`, …), Steward shows what it would actually touch (files and size, commits dropped, uncommitted edits) and asks Proceed / Cancel / Allow for session.

Status: in development (v0.1). Collision guard across sessions is still being built. See `requirements/` for the PRD, plan and activity log.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install steward --marketplace jjayarajdev/claude-steward
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install steward --marketplace jjayarajdev/claude-steward
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `jjayarajdev/claude-steward`, then Add plugin.

## Use

- `/steward` toggles the pane; `/steward help` lists every command.
- `/steward brief` previews a handoff brief; `/steward handoff` hands off.
- `/steward ttl 5` sets the cache window estimate (minutes).
- `/steward blast <command>` previews what a destructive command would touch, without running it.
- `/steward allow rm -rf node_modules` lets that exact command run without asking, in every session; `/steward allow` lists them, `/steward allow remove <command>` takes one back.

Each feature can be turned off in the plugin's settings.

## Develop

`steward/` is the mod. `scripts/check.sh <mod dir>` validates, type-checks and runs the tests (`claude plugin test`).

## License

MIT
