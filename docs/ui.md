# Page API

Served by `rooms serve` (src/server.ts). The page (`web/index.html`) builds URLs relative to its own folder, so it works under a prefix (`/rooms/`, `/tracker/`). Shapes follow the UX spec §8 (the research folder has the full spec).

## Reads (open to whoever reaches the port)

| Route | Returns |
|---|---|
| `GET /api/inbox` | `{now, count, pulse{moving,waiting_outside,stuck,paused,idle,needs_you}, alarms[], cards[], going_ahead[], waiting_on_team[]}`. Cards are sorted most blocking first. A card waiting on the lead's reply to your question sits in `waiting_on_team`. |
| `GET /api/rooms` | `{rooms_home, rooms: RoomSummary[]}` |
| `GET /api/rooms/{room}` | `RoomDetail`: summary plus `phase, lead, work{moving,review,ready_unstaffed,waiting,blocked_on_you,done_count}, plan{waves[{label,items:[id]}], items[{id,title,state,summary,after:[id],owner_name?,age_min?,waits_on?}]}, decided[], lead_note, attention[], paused` |
| `GET /api/cards/{room}/{id}` | Any record (card, item, refinement, `PRD`): `{id,title,state,owner,why,source,thread[],history[],sections[{h,text}],file}` |
| `GET /api/receipts?ids=a,b` | `[{id, delivery: saved|lead_told|lead_read|error|unknown, at, error?}]` |

A card has `room, room_title, room_status, room_status_note?, id, kind (decision|premise|ask|todo|prd), title, urgent?, hard_to_undo, waiting_min, updated, consequence, blocking_score, options[{key,label}], pick?{key,reason}, steps?[{text,copy?,url?}], free_text?, due_at?, default_key?, thread?[{who,at,text,mine}], reply_unread?`.

## Writes (need `ROOMS_USERS` to list the `Tailscale-User-Login` header; JSON or `text/plain` JSON for sendBeacon)

| Route | Body | Effect |
|---|---|---|
| `POST /api/cards/{room}/{id}/answer` | `{choice, note?, if_match?, resume_too?}` | 202 `{receipt_id}`. 409 `{changed:true}` if the card changed since `if_match`. Answering twice is harmless (`already:true`). `choice: "note"` answers a free-text ask. |
| `POST /api/cards/{room}/{id}/question` | `{text}` | Appends to the card's Questions and tells the lead. The card stays open. |
| `POST /api/cards/{room}/{id}/stop` | `{choice?, note?}` | Stops a going-ahead card: with `choice` it answers that option instead; without one it becomes an open card. |
| `POST /api/rooms/{room}/pause` | `{paused: bool}` | Pauses or resumes the room and tells the lead. |
| `POST /api/rooms/{room}/wake` | `{note?}` | Asks the lead to get the room moving. |

The room’s **View plan** disclosure shows every recorded item, including done and dropped steps. From 960px wide it is a scrollable dependency graph across the full width; narrower, the same layout reads as a list of stages (dependency depth), each step naming what it waits on. By default it shows only steps left to do: finished steps collapse into one stub (the graph’s first node, the list’s first row), and a step that waited on them says so. The “Left to do / All steps” choice is remembered per room. Summaries use the item’s Summary section, then its preamble, then Acceptance criteria (up to 400 characters). Each step opens its full record. The disclosure and graph scroll position survive polling.

From 960px wide the tabs become a top bar, the inbox gets a rooms column beside the queue, the room view puts work beside the team, then the plan, then the lead’s note beside recent decisions, and sheets open as centred dialogs.

Agents: `lead.agent` and each item's `agent` carry `{session,name,hue,svg}` derived from the session id (src/identity.ts); `GET /api/rooms/<room>/agents/<session>` gives lifecycle, items received/completed and the BRIEF charter; the page route is `#/agent/<room>/<session>`.

Room detail also includes `team_roster` (the brief’s Team section) and `team[{name,items}]`. Team assignments carry item state, optional tier and session state; members without open assignments remain visible. The Team disclosure shows the roster, lead status and linked assignments.
