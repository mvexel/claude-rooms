# claude-rooms

Rooms for Claude Code agent teams. A **room** is one project: a lead session that plans the work and keeps the record, worker sessions that each do one item in their own worktree, and you (the owner), deciding on a phone page. The record is plain markdown in a git repo of its own (`~/rooms`), so it outlives every session. It needs nothing beyond Claude Code.

**Docs: <https://mvexel.github.io/claude-rooms/>**: install, your first room, shaping a team, cards, the page, configuration and troubleshooting.

## Flexible on purpose

There is no default team and no required process. You say what the work needs, in your own words ("one builder, and have someone review it before merging"), and the lead staffs it. Roles, charters and model tiers are names you choose, not settings the tool checks. The `rooms` command enforces only a few rules: a feature's PRD is agreed before building, an item says what done means before it starts and reports a result when it ends, and only your decisions reach you. See [Your team](https://mvexel.github.io/claude-rooms/#team).

## Quick start

You need Node 24+, git and Claude Code, on macOS or Linux.

```sh
git clone https://github.com/mvexel/claude-rooms ~/dev/claude-rooms
~/dev/claude-rooms/cli/rooms.ts install   # links `rooms` into ~/.local/bin; asks to let sandboxed sessions write ~/rooms
rooms init                                 # creates ~/rooms (set CLAUDE_ROOMS_HOME to move it)
```

Run `rooms install` in a terminal, not inside Claude Code. Then, at a Claude Code prompt:

```
/plugin marketplace add mvexel/claude-rooms
/plugin install rooms@mvexel-rooms
```

Start the page with `rooms serve` and open <http://127.0.0.1:8787/>. Open `claude` in your repo (accept the trust prompt: workers start in worktrees of it) and ask: "Start a room to add a `--json` flag to the export command." The lead takes it from there. The walkthrough is in [Your first room](https://mvexel.github.io/claude-rooms/#first-room).

### Serving beyond the machine

`rooms serve` treats a connection from loopback with no proxy headers as the local user, who may answer even when `ROOMS_USERS` is set. Anything that forwards to loopback without adding headers (`tailscale serve --tcp`, `ssh -R`, `socat`) therefore counts as local. Set `ROOMS_TRUST_LOOPBACK=0` to turn that off; then every POST needs a login listed in `ROOMS_USERS`. POSTs with an `Origin` that doesn't match `Host` are refused (403), and POST bodies must be `application/json`.

## How it fits together

```
 phone page ──tap──▶ rooms serve ──event──▶ room inbox ──▶ lead session (plugin: between tool calls, or when idle)
                          │                                └▶ or a one-shot lead turn (claude -p) when no lead is live
                          └─ sweep every 15 s: deliver events, apply due defaults, commit, mirror-push
 lead ── rooms spawn ──▶ worker session (own worktree, scratch, model tier) ── rooms done / need ──▶ event to the lead
```

- **Plugin `rooms`** (`hooks/register.ts`, `skills/`): the lead and worker skills, and hooks that deliver events to a live session, record "D05 b" typed in chat, and tell the lead when a worker stops without reporting. Adds `/room` and a status-line entry.
- **CLI `rooms`** (`cli/rooms.ts`, TypeScript on Node 24, no dependencies). See `rooms help`.
- **Page** (`web/index.html`, served by `rooms serve`): one inbox across all rooms, most blocking first.

The design and the reasoning behind it are in [docs/design.md](docs/design.md); the page's API is in [docs/ui.md](docs/ui.md).

**Hall monitor.** Past `hallMonitor.queueLimit` parallel-ready items waiting behind one `owner` role, the excess `rooms status` names clones ("dev 2") and `rooms spawn` starts them under that name; `hallMonitor.maxThreads` (default 4) caps running workers per room, and spawn refuses beyond it unless `--over-cap`. Both are editable on the Settings page; see Configuration in the docs.

## Develop

```sh
npm test                                    # node --test, end to end through the CLI, never starts a session
claude plugin validate .
claude --plugin-dir ~/dev/claude-rooms      # a session with the working copy of the plugin
```

The docs site is `site/index.html`, published from the `gh-pages` branch; change both together.

`.github/workflows/issue-watch.yml` runs when the repo owner opens an issue: Claude fixes it on a branch, runs `npm test` on Node 24 and opens a PR that says `Fixes #n`. It never merges. Issues from anyone else, and issues labeled `backlog`, are skipped. It needs a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`claude setup-token`).

## License

Public domain ([Unlicense](LICENSE))
