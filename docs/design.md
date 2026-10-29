# claude-rooms: design

## The shape

A room is one project: a lead that plans and keeps the record, workers that each do one item, and an owner who decides on a phone page. Everything durable is plain markdown in a git repo of its own (`~/rooms`), so no conversation has to be remembered. It runs on plain Claude Code: workers are `claude --bg` sessions, and the lead is either a session you can talk to or a one-shot turn started for a batch of events.

Choices that shape the rest:

- **TypeScript on Node 24, no dependencies, no build step.** It ships as a Claude Code plugin (`rooms`) plus a CLI.
- **Room data lives in its own repo**, separate from the code, so the plugin can be shared without anyone's rooms.
- **A hybrid lead.** A resumable lead session for conversation. When none is live, events start one-shot lead turns that read the record, act, and exit.
- **A light PRD gate.** Only feature rooms (`--feature`) get one. The lead drafts it, the owner agrees it, and the 120-line cap is enforced. Before agreement only research items run (at most 4 hours each, three open at a time).
- **The owner sees only what is theirs.** Cards are for one-way doors, premises, the PRD gate, tasks only the owner can do, and free-text questions. Reversible calls are provisional, with a default that applies itself when due unless the owner stops it.
- **Local git first.** Commits are debounced. Pushing to a remote, if there is one, is an optional background mirror; nothing waits on it.
- **Rules live in code.** The CLI enforces the build lock, a written brief before work starts, a Result and a named successor before an item is done, card routing, defaults and research caps. The skills stay short.

## Waking a session

What Claude Code offers, tested:

| Route | Result |
|---|---|
| `claude --bg --resume <id> "msg"` on a live, idle session | Forks: "already running … started a copy". The original never hears it. |
| Cross-session `SendMessage` | Works, but only as a tool call from inside a session. |
| `claude stop`, then `--resume` | Resumes in place with its history: same id, new process. |
| The plugin's `$.prompt.submit` from inside the session | Works: a tap reaches an idle lead, which acts on it. |

So nothing outside a session ever resumes one that is running. Events go to a per-room inbox (`$CLAUDE_ROOMS_STATE/rooms/<room>/inbox.jsonl`), and `dispatch` decides who reads it:

1. **The lead's plugin holds a fresh lease** (it beats every 5 s; fresh means under 45 s). The plugin takes the inbox: between tool calls as tool-result `context` (the model reads it with no extra turn), or when idle as one prompt. Several events become one delivery.
2. **No lease, and the session list shows the lead isn't running**, or there is no lead. A one-shot lead turn (`claude -p`, in `~/rooms`, permission mode and tools from config) gets the events and the room digest, acts, and exits. Only one turn runs per room at a time.
3. **The lead runs without the plugin**, or the session list is unavailable. The events wait; nothing is guessed. The room shows as *stuck* with that reason.

Workers get the same mechanism keyed by item (`<room>/<Tnn>`). A worker whose session has ended is resumed with the message, which is safe only because the session list says it isn't running (`resumeStopped`).

Receipts follow each event: `saved → lead_told → lead_read`. The page shows them.

## Hooks instead of rituals

- A worker whose turn ends with its item still `doing` emits an event, so the lead never polls.
- "D05 b" typed by the owner to the lead is recorded by a prompt hook before the lead reads it.
- Taps carry `if_match`, so a card that changed is not answered blind. Answers return 202 at once; git happens in the sweep.
- Workers start with an explicit permission mode and model tier, and the choice is logged on the item.

## Room status

Seven statuses, decided in one place (`src/state.ts`), each with one sentence for the owner and at most one action: needs you, stuck, moving, waiting outside, paused, idle, done. "Stuck" means ready work that nothing will start, or events the lead can't receive. `rooms status --yield` judges the room as if the lead stopped now.

## The page

One inbox across rooms, alarms for stuck rooms, a single card layout for every kind, the team's pick on each card, one tap with an undo window, delivery receipts, and three tabs. The API is in `docs/ui.md`.

## Not built yet

- Push notifications (ntfy or similar) for stuck rooms and due defaults.
- Wrap-up reports at room close.
- Budget awareness in `rooms spawn`.

## Known gaps

- Mid-turn delivery through tool-result `context` follows the plugin API docs; only idle delivery has been seen working against a real session.
- One-shot lead turns need the plugin installed at user scope, so the skill is there. `claude -p` runs in `~/rooms` without a trust prompt.
- Opening the lead session (`rooms chat`) while a one-shot turn is still running means both act on the room until the turn exits.
