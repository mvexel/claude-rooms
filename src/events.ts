import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backend, sendReceiptToHub } from './backend.ts'
import { LEASE_FRESH_MS, claudeBin, config, roomsHome, stateDir } from './config.ts'
import { withLock } from './git.ts'
import { Room } from './room.ts'
import { findSession, isEnded, isRunning, liveness, listSessions, resumeStopped } from './sessions.ts'

// Events: everything the lead must hear (a tap, a worker done, a need) is
// appended to the room's inbox. Who reads it:
//   - a live lead session whose plugin holds the lease takes it, between
//     tool calls (as context) or when idle (as one prompt);
//   - otherwise a one-shot lead turn (`claude -p`) is started for the room,
//     reads the room record and the events, does the next step, and exits.
// A lead session that is running but holds no lease (no plugin) is never
// resumed or doubled: its events wait, and status says so.

export type Event = { id: string; at: string; text: string }
export type Delivery = 'saved' | 'lead_told' | 'lead_read' | 'error'

const roomState = (key: string) => join(stateDir(), 'rooms', ...key.split('/'))
const inboxFile = (room: string) => join(roomState(room), 'inbox.jsonl')
const leaseFile = (room: string) => join(roomState(room), 'lease.json')
const receiptsFile = () => join(stateDir(), 'receipts.json')
const turnFile = (room: string) => join(roomState(room), 'turn.json')

function stamp(): string {
  return new Date().toISOString().slice(0, 19) + 'Z'
}

// ---- receipts --------------------------------------------------------------

type Receipts = { [id: string]: { delivery: Delivery; at: string; error?: string } }

function readReceipts(): Receipts {
  try {
    return JSON.parse(backend().read(receiptsFile()) ?? '{}')
  } catch {
    return {}
  }
}

export function setReceipt(ids: string[], delivery: Delivery, error?: string, room?: string): void {
  if (!ids.length) return
  let mine = ''
  withLock('receipts', () => {
    const r = readReceipts()
    const cutoff = Date.now() - 7 * 86_400_000
    for (const [k, v] of Object.entries(r)) if (Date.parse(v.at) < cutoff) delete r[k]
    for (const id of ids) r[id] = { delivery, at: stamp(), ...(error ? { error } : {}) }
    backend().write(receiptsFile(), JSON.stringify(r))
    mine = JSON.stringify(Object.fromEntries(ids.map(id => [id, r[id]])))
  })
  if (room) sendReceiptToHub(room, receiptsFile(), mine)
}

export function receipts(ids: string[]): { id: string; delivery: Delivery | 'unknown'; at?: string; error?: string }[] {
  const r = readReceipts()
  return ids.map(id => (r[id] ? { id, ...r[id] } : { id, delivery: 'unknown' as const }))
}

// ---- inbox -----------------------------------------------------------------

export function emit(room: string, text: string, opts: { dispatch?: boolean } = {}): string {
  const ev: Event = { id: randomUUID().slice(0, 12), at: stamp(), text: text.trim() }
  backend().append(inboxFile(room), JSON.stringify(ev) + '\n')
  setReceipt([ev.id], 'saved', undefined, room)
  if (opts.dispatch !== false) {
    try {
      dispatch(room)
    } catch (e) {
      setReceipt([ev.id], 'error', (e as Error).message, room)
    }
  }
  return ev.id
}

export function pending(room: string): Event[] {
  return (backend().read(inboxFile(room)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Event)
}

// Take the whole inbox at once: many events become one delivery.
export function take(room: string): Event[] {
  const evs = (backend().claim(inboxFile(room)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Event)
  setReceipt(evs.map(e => e.id), 'lead_read', undefined, room)
  return evs
}

export function render(room: string, evs: Event[]): string {
  if (!evs.length) return ''
  const head = evs.length === 1 ? `[rooms] 1 new event in room ${room}:` : `[rooms] ${evs.length} new events in room ${room}:`
  return [head, ...evs.map(e => `- ${e.at.slice(11, 16)}Z ${e.text.replace(/^\[rooms\]\s*/, '')}`)].join('\n')
}

// ---- lease -----------------------------------------------------------------

export function beat(room: string, session: string): void {
  backend().write(leaseFile(room), JSON.stringify({ session, at: Date.now() }))
}

export function lease(room: string): { session: string; at: number } | undefined {
  try {
    return JSON.parse(backend().read(leaseFile(room)) ?? '')
  } catch {
    return undefined
  }
}

export function leaseFresh(room: Room): boolean {
  const l = lease(room.name)
  return !!l && l.session === room.leadSession() && Date.now() - l.at < LEASE_FRESH_MS
}

// ---- dispatch --------------------------------------------------------------

export type Route = 'live-lead' | 'turn-started' | 'turn-running' | 'held' | 'empty'

// Decide who reads the room's events. Safe to call often.
export function dispatch(roomName: string): { route: Route; why: string } {
  const room = new Room(roomName)
  if (!room.exists()) return { route: 'held', why: 'no such room' }
  const evs = pending(roomName)
  if (!evs.length) return { route: 'empty', why: '' }
  if (room.isClosed()) return { route: 'held', why: 'room is closed' }
  return withLock(`dispatch-${roomName}`, () => {
    if (leaseFresh(room)) {
      setReceipt(evs.map(e => e.id), 'lead_told', undefined, roomName)
      return { route: 'live-lead' as Route, why: 'the lead session picks it up' }
    }
    const t = turnRunning(roomName)
    if (t) return { route: 'turn-running' as Route, why: `a lead turn is running (pid ${t})` }
    const lead = room.leadSession()
    if (lead) {
      const sessions = listSessions()
      if (!sessions.length) return { route: 'held' as Route, why: 'session list unavailable; not guessing' }
      const s = findSession(lead, sessions)
      const live = liveness(lead, sessions)
      if (live === 'unknown') return { route: 'held' as Route, why: `lead session ${lead} liveness unknown; not starting a second lead` }
      if (live === 'alive') return { route: 'held' as Route, why: `lead session ${s?.id ?? lead} is running but not checking in; install the plugin there, or restart rooms serve if it predates the plugin` }
    }
    const taken = take(roomName)
    if (!taken.length) return { route: 'empty' as Route, why: '' }
    startTurn(room, taken)
    return { route: 'turn-started' as Route, why: 'a one-shot lead turn handles it' }
  })
}

export function turnRunning(room: string): number | undefined {
  try {
    const t = JSON.parse(readFileSync(turnFile(room), 'utf8'))
    process.kill(t.pid, 0)
    return t.pid
  } catch {
    return undefined
  }
}

// turn.json and turns.log describe a process on this machine, so they stay
// plain local files, outside the backend.
// A one-shot lead: reads the record, handles the events, exits. The record,
// not a transcript, is its memory.
function startTurn(room: Room, evs: Event[]): void {
  const c = config()
  const prompt = [
    `You are the lead of room ${room.name} for one turn. Load the rooms:lead skill.`,
    `Room record: ${room.dir}. Start with: rooms status ${room.name}`,
    render(room.name, evs),
    'Handle these events: take the next step (dispatch, decide, or ask the owner), keep the record current, then end your turn. Do not wait for workers; their results come back as new events.',
  ].join('\n\n')
  const args = ['-p', '--permission-mode', c.lead.permissionMode]
  if (c.lead.model) args.push('--model', c.lead.model)
  if (c.lead.allowedTools.length) args.push('--allowedTools', c.lead.allowedTools.join(','))
  // `--allowedTools` is variadic and would swallow the prompt without `--`.
  args.push('--', prompt)
  mkdirSync(roomState(room.name), { recursive: true })
  const log = openSync(join(roomState(room.name), 'turns.log'), 'a')
  appendFileSync(join(roomState(room.name), 'turns.log'), `\n=== ${stamp()} turn for ${evs.map(e => e.id).join(',')}\n`)
  const child = spawn(claudeBin(), args, {
    cwd: roomsHome(),
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ROOMS_AS: 'lead', ROOMS_TURN: '1' },
  })
  writeFileSync(turnFile(room.name), JSON.stringify({ pid: child.pid, at: stamp(), events: evs.map(e => e.id) }))
  child.unref()
  setReceipt(evs.map(e => e.id), 'lead_told', undefined, room.name)
}

// ---- workers -----------------------------------------------------------------

// A message for the worker on an item: its plugin takes it like the lead's,
// and a worker whose session ended is resumed with it (never a running one).
export function tellWorker(room: Room, itemId: string, agent: string, text: string): string {
  const key = `${room.name}/${itemId}`
  const id = emit(key, text, { dispatch: false })
  const l = lease(key)
  if (l && l.session === agent && Date.now() - l.at < LEASE_FRESH_MS) {
    setReceipt([id], 'lead_told', undefined, key)
    return 'the worker picks it up'
  }
  const sessions = listSessions()
  const s = sessions.length ? findSession(agent, sessions) : undefined
  if (!s) return 'held: the worker session is unknown'
  if (isRunning(s, sessions)) return 'queued: the worker session picks it up when it next polls (if it never does, it runs without the rooms plugin)'
  if (!isEnded(s, sessions)) return 'held: the worker session liveness is unknown'
  const evs = take(key)
  try {
    resumeStopped(s, render(key, evs), sessions)
    return 'the worker session was resumed with it'
  } catch (e) {
    for (const ev of evs) backend().append(inboxFile(key), JSON.stringify(ev) + '\n')
    return `held: ${(e as Error).message}`
  }
}

// ---- sessions ----------------------------------------------------------------

// Mail for one session, whatever its role: the plugin takes it on every poll.
// Room names can't start with "@", so the key never meets a room's.
export const mailKey = (session: string) => `@session/${session}`

// A note for a session (a lead that was replaced): its plugin takes it on its
// next poll, so a session that has ended hears it when it is next opened.
export function tellSession(session: string, text: string): string {
  emit(mailKey(session), text, { dispatch: false })
  return 'told to hand off (with the rooms plugin it hears it within a minute, or when next opened)'
}

// ---- sweep -----------------------------------------------------------------

// Run by the page server every few seconds: deliver what is waiting, apply
// due provisional defaults (in answer.ts), commit (in git.ts).
export function sweepRooms(): void {
  for (const room of Room.all()) {
    try {
      dispatch(room.name)
    } catch {}
  }
}
