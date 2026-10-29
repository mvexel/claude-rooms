# Page API

Served by `rooms serve` (src/server.ts). The page (`web/index.html`) builds URLs relative to its own folder, so it works under a prefix (`/rooms/`, `/tracker/`). Shapes follow the UX spec §8 (the research folder has the full spec).

## Reads (open to whoever reaches the port)

| Route | Returns |
|---|---|
| `GET /api/inbox` | `{now, count, pulse{moving,waiting_outside,stuck,paused,idle,needs_you}, alarms[], cards[], going_ahead[], waiting_on_team[]}`. Cards are sorted most blocking first. A card waiting on the lead's reply to your question sits in `waiting_on_team`. |
| `GET /api/rooms` | `{rooms_home, rooms: RoomSummary[]}` |
| `GET /api/rooms/{room}` | `RoomDetail`: summary plus `phase, lead, work{moving,review,ready_unstaffed,waiting,blocked_on_you,done_count}, plan{waves[{label,items:[id]}]}, decided[], lead_note, attention[], paused` |
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
