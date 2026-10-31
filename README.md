# claude-rooms

Rooms for Claude Code agent teams. A **room** is one project: a lead session that plans the work and keeps the record, worker sessions that each do one item in their own worktree, and you (the owner), deciding on a phone page. The record is plain markdown in a git repo of its own (`~/rooms`), so it outlives every session.

It needs nothing beyond Claude Code: workers are `claude --bg` sessions, and the lead is either a session you can talk to or a short one-shot turn started for each batch of events.

## How it fits together

```
 phone page ──tap──▶ rooms serve ──event──▶ room inbox ──▶ lead session (plugin: between tool calls, or when idle)
                          │                                └▶ or a one-shot lead turn (claude -p) when no lead is live
                          └─ sweep every 15 s: deliver events, apply due defaults, commit, mirror-push
 lead ── rooms spawn ──▶ worker session (own worktree, scratch, model tier) ── rooms done / need ──▶ event to the lead
```

- **Plugin `rooms`** (`hooks/register.ts`, `skills/`). In the lead session it holds the room's lease and delivers events: as context on the next tool result mid-turn (no extra turn), or as one prompt when idle. It records "D05 b" typed in chat before the lead reads it. In a worker session it delivers the lead's messages, and tells the lead if the worker's turn ended without `rooms done`. It also adds `/room` and a status-line entry.
- **CLI `rooms`** (`cli/rooms.ts`, TypeScript on Node 24, no dependencies). See `rooms help`.
- **Page** (`web/index.html`, served by `rooms serve`): one inbox across all rooms, most blocking first; one tap with an undo window; receipts that say when the lead has read your answer.

## Install

```sh
git clone https://github.com/mvexel/claude-rooms ~/dev/claude-rooms
~/dev/claude-rooms/cli/rooms.ts install   # links `rooms` into ~/.local/bin; offers to allow ~/rooms in the sandbox
rooms init                                 # creates ~/rooms (set CLAUDE_ROOMS_HOME to move it)
```

Everything rooms writes lives under `~/rooms`. Claude Code's Bash sandbox can't write there unless your settings allow it, and a plugin can't change that. So `rooms install` asks before adding `~/rooms` to `sandbox.filesystem.allowWrite` in `~/.claude/settings.json`; it keeps a `.bak`. Run it in a terminal, not from inside Claude Code; pass `--yes` to skip the question. Sessions whose sandbox can't write `~/rooms` get a note on their first prompt about rooms.

Then install the plugin so every session has the skills and hooks. At a Claude Code prompt, add the marketplace from GitHub and install:

```
/plugin marketplace add mvexel/claude-rooms
/plugin install rooms@mvexel-rooms
```

To use a local clone instead, `/plugin marketplace add ~/dev/claude-rooms`. Room role instructions are added as context when a prompt is submitted. This works with Claude Code's built-in `cc-plugin-sec-default` guard on managed machines and Team/Enterprise accounts; Rooms does not need to modify the system prompt.

## The page server

`rooms serve [--port 8787] [--host 127.0.0.1]` serves the phone page and runs the sweep (every 15 s: deliver events, apply due defaults, commit, mirror-push). It listens on loopback by default and refuses to listen on any other address unless `ROOMS_USERS` is set. Only the Tailscale logins listed in `ROOMS_USERS` (comma-separated) can answer; with it unset, a loopback server accepts every write. `ROOMS_READONLY=1` serves the page only, with no sweep and no writes.

To reach it from your phone over a tailnet, keep it on loopback and let Tailscale front it:

```sh
rooms serve &                      # or run it as a service, below
tailscale serve --bg --set-path /rooms http://127.0.0.1:8787
```

As a user service (`deploy/claude-rooms.service`):

```sh
cp deploy/claude-rooms.service ~/.config/systemd/user/ && systemctl --user enable --now claude-rooms
```

Set `ROOMS_USERS` in the unit before you expose it. If `node` comes from a version manager, check that the unit's `PATH` reaches it (`journalctl --user -u claude-rooms` shows `node: No such file or directory` if not). After updating the plugin or the clone, `systemctl --user restart claude-rooms` loads the new code.

### In a container

`Dockerfile` and `compose.production.yml` run `rooms serve` in a minimal Debian image (git, gh, jq, curl, rsync, procps, tini), built on the host (`pull_policy: build`; the image is never pushed to a registry). The image has no node, claude or rooms: the host home is bind-mounted at the same path, and `~/.local/node/bin` and `~/.local/bin` supply them. The container runs as `ROOMS_UID`/`ROOMS_GID` (default 1000) with `network_mode: host`, so the server stays on `127.0.0.1:8788` (`ROOMS_PORT` changes it) and `tailscale serve` on the host reaches it. Set `ROOMS_USERS` (required: compose refuses to start without it) and `ROOMS_HOME` (the host home directory the compose file mounts; the default in the file is the author's, so set it) in the environment. `ROOMS_MEM_LIMIT` (default `8g`) and `ROOMS_CPUS` (default `4`) cap the container. Don't run it alongside the systemd unit: two servers on one `~/rooms` is the double-host case below. A container restart ends running workers, because lead and worker sessions are children of the container; restart it only between turns.

Optional: `git -C ~/rooms remote add origin <private repo>`. Commits are then mirrored in the background. Nothing waits on a push.

## Storage

Records and runtime state are plain files by default. Every read and write goes through one `Backend` interface (`src/backend.ts`); `CLAUDE_ROOMS_BACKEND=<module path>` loads another implementation, for example one that keeps records in a service. A hosted hub is such an optional backend; nothing here needs it. Locks, git, worker scratch, sessions, config and sandbox settings stay local. See [docs/design.md](docs/design.md).

## Where it runs

Rooms run on one machine: the lead and worker sessions, the records in `~/rooms`, and `rooms serve` (the page, plus the sweep that delivers events and commits). Choose either setup:

Only one room per repository may be open on a machine. Different repositories
can each have an open room. Use `rooms new <room> "<Title>" --repo <path>`;
the repository defaults to the current checkout. Paused rooms retain their slot,
and linked worktrees count as the same repository. Closed rooms remain as history.

- **Locally**, on your laptop. This is fine for a room you watch while you work. While the laptop sleeps, workers pause and the page can't be reached. Events wait in the inbox and are delivered on wake.
- **On an always-on host**, like a headless box on your tailnet. Rooms keep moving while you're away.

Never run the same `~/rooms` on two machines at once (with the default file backend). Inboxes, leases and the session list are local, so two hosts would each start their own lead turns and their commits would conflict. A git remote is a mirror for backup and reading, not a sync between live hosts.

From another machine:

| To | Do |
|---|---|
| Answer cards, pause, wake a lead | Open the page over the tailnet (see The page server) |
| Talk to a room's lead | `ssh <host> -t rooms chat <room>` attaches to it, or resumes it |
| Work in the rooms with any `rooms` command | `ssh <host> -t 'cd ~/rooms && claude'` |
| Chat with a lead from claude.ai/code or the app | Start it on the host with `cd ~/rooms && claude --remote-control lead-<room>`, then run `rooms lead <room>` inside it |

A lead or worker running on a different machine from its room isn't supported: the CLI and plugin read the host's files and session list directly.

## Use

In a Claude Code session, ask for a room ("start a room for X", "form a team for Y"). The lead skill takes it from there: `rooms new`, premises, a PRD for features, the item graph, then `rooms spawn` for each ready item. You answer cards on the page, or in chat as `D05 b`. `rooms chat <room>` opens the room's lead session to talk to it. `rooms status` shows every room.

Each worker gets its own worktree and branch, `<repo>-<room>-<tnn>` on `rooms/<room>/<tnn>`, named from the main checkout even when `--repo` points at a linked worktree; research items get none. Nothing removes them on its own: `rooms prune <room>` lists the worktrees and branches of done or dropped items and which can go (merged into the room's integration branch or the repo's HEAD, with a clean worktree), and `rooms prune <room> --yes` removes those. `rooms close` reminds you when some are left.

`rooms pause <room>` stops new work (`rooms spawn` refuses) and `rooms resume <room>` lifts it; `rooms close <room> "reason"` ends the room. `rooms withdraw <room> <Dnn> "reason"` takes an open card off the page and keeps the reason in the record.

Run `rooms status` outside Claude Code's Bash sandbox when you can: inside it the session list hides pids, so live sessions show as liveness unknown rather than as running or ended.

Who gets asked what:

- **Your cards** are one-way doors (names, public API, deploys, merges to main, spending), premises, the PRD gate, tasks only you can do, and free-text questions.
- **Reversible calls** go ahead at their due time unless you stop them on the page.
- **Engineering choices** stay with the team.

## Configuration

`~/.config/claude-rooms/config.json` (all optional):

```json
{
  "tiers": { "light": { "model": "claude-haiku-5-5", "effort": "medium" },
             "standard": { "model": "claude-sonnet-5-5", "effort": "medium" },
             "review": { "model": "claude-opus-5-5", "effort": "high" } },
  "worker": { "permissionMode": "auto", "tier": "standard" },
  "lead": { "permissionMode": "auto", "allowedTools": ["Bash(rooms *)", "Read", "Edit", "Write"] },
  "provisionalMinutes": 60,
  "commitDebounceMs": 60000
}
```

Environment variables:

| Variable | Default | Sets |
|---|---|---|
| `CLAUDE_ROOMS_HOME` | `~/rooms` | where room records live |
| `CLAUDE_ROOMS_STATE` | `$CLAUDE_ROOMS_HOME/.state` | inboxes, leases and receipts (kept out of git; moved from `~/.local/state/claude-rooms` in 0.3) |
| `ROOMS_USERS` | unset | Tailscale logins allowed to answer on the page |
| `ROOMS_HUMAN` | unset | an extra name accepted for the `human` decider, for records that name the owner |
| `ROOMS_AS` | unset | the name your Log lines carry |
| `ROOMS_READONLY` | unset | `1`: `rooms serve` serves the page only, no sweep, no writes |
| `CLAUDE_ROOMS_BACKEND` | unset (local files) | path or URL of a storage backend module |
| `CLAUDE_ROOMS_CONFIG` | `~/.config/claude-rooms/config.json` | the config file |
| `CLAUDE_ROOMS_CLAUDE` | `claude` | the Claude Code executable used to start sessions |
| `CLAUDE_ROOMS_CLI` | `rooms` | the `rooms` executable the plugin hooks call |

## Room status in Claude Code

The plugin status entry shows the current room’s moving/waiting counts, items in review, owner cards and next ready step. It refreshes with the plugin poll. For a custom Claude Code status line, use `rooms statusline`: it reads the session ID from Claude’s stdin JSON and stays blank outside a room. `rooms statusline <room>` selects one explicitly.

```json
{
  "statusLine": {
    "type": "command",
    "command": "rooms statusline",
    "refreshInterval": 5
  }
}
```

Merge this into Claude settings only if you want to use it as your status line; an existing status-line script can call the same command with the original stdin JSON. Waiting counts blocked items and queued items that cannot start; next is the first ready item, suppressed when paused or closed.

## Develop

```sh
npm test                                    # node --test, end to end through the CLI, never starts a session
claude plugin validate .
claude --plugin-dir ~/dev/claude-rooms      # a session with the working copy of the plugin
```

The design, and the reasoning behind it, are in [docs/design.md](docs/design.md). The page's API is in [docs/ui.md](docs/ui.md).

### Issue watch

`.github/workflows/issue-watch.yml` runs when the repo owner opens an issue: Claude fixes it on a branch, runs `npm test` on Node 24 and opens a PR that says `Fixes #n`. It never merges. Issues from anyone else, and issues labeled `backlog`, are skipped. It runs on a Claude subscription: create a token with `claude setup-token` and store it as the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.

## License

Public domain ([Unlicense](LICENSE))
