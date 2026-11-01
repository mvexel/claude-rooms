import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Conflict, dueOf, options, recordAnswer, tapAnswer, tapQuestion } from './answer.ts'
import { roomsHome } from './config.ts'
import { emit, receipts } from './events.ts'
import { Record } from './record.ts'
import { OPEN_ITEM, Room } from './room.ts'
import { type Session, findSession, isEnded, isRunning, listSessions } from './sessions.ts'
import { cardRank, doingSince, isHuman, roomState, tryRoomState, type RoomState, waves } from './state.ts'
import { closeRoom, setPaused, setTitle, sweep } from './commands.ts'

// The owner's page and its API (shapes in docs/ui.md, from the UX spec §8).
// GETs are open to whoever reaches the port; POSTs need ROOMS_USERS to list
// the Tailscale-User-Login, unless the server listens on loopback only and
// ROOMS_USERS is unset. Writes return 202 at once: commits and pushes happen
// in the sweep, and the lead hears through the room's events.
// ROOMS_READONLY=1 serves the page only, no sweep and no writes: a preview of
// another checkout beside the real server, on the same rooms.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// What the page needs to install as an app, served as is from web/.
const APP_FILES: { [path: string]: string } = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
}

const minutes = (stamp: string): number | undefined => {
  const t = Date.parse(stamp)
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : undefined
}

function kindOf(d: Record): string {
  const t = d.get('type') || 'decision'
  return t === 'refinement' ? 'prd' : t
}

function titleOf(room: Room, id: string): string {
  try {
    return room.find(id).get('title')
  } catch {
    return id
  }
}

function consequence(room: Room, d: Record): string {
  if (d.get('urgent')) return d.get('urgent')
  const open = room.items().filter(i => OPEN_ITEM.has(i.get('state')))
  const direct = d.list('blocks').filter(b => open.some(i => i.get('id') === b))
  if (!direct.length) return 'Nothing waits on this yet'
  const names = direct.slice(0, 2).map(id => titleOf(room, id))
  return `Unblocks ${names.join(', ')}${direct.length > 2 ? ` and ${direct.length - 2} more` : ''}`
}

function thread(d: Record) {
  return d
    .section('Questions')
    .split('\n')
    .map(l => l.match(/^- ([QA]) · ([^·]+?) · (\d\d:\d\d)Z?: "(.*)"$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ who: m[2].trim(), at: m[3].trim(), text: m[4], mine: m[1] === 'Q' }))
}

function steps(d: Record) {
  return d
    .section('Steps')
    .split('\n')
    .map(l => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean)
    .map(text => {
      const url = text.match(/https?:\/\/\S+/)?.[0]
      const copy = text.match(/`([^`]+)`/)?.[1]
      return { text, ...(copy ? { copy } : {}), ...(url ? { url } : {}) }
    })
}

function card(room: Room, d: Record, st: RoomState) {
  const kind = kindOf(d)
  const due = dueOf(d)
  const th = thread(d)
  return {
    room: room.name,
    room_title: room.brief.get('title') || room.name,
    room_status: st.status,
    room_status_note: room.isPaused() ? `paused · ${ageWord(room.brief.get('paused'))}` : room.isClosed() ? 'the room is done; answering wakes no one' : undefined,
    id: d.get('id'),
    kind,
    title: d.get('title'),
    urgent: d.get('urgent') || undefined,
    hard_to_undo: d.get('door') === 'one',
    waiting_min: minutes(d.get('opened')) ?? 0,
    updated: d.get('updated'),
    consequence: consequence(room, d),
    blocking_score: cardRank(room, d),
    options: options(d).map(o => ({ key: o.key, label: o.text })),
    pick: d.get('pick') ? { key: d.get('pick'), reason: d.get('pick_reason') } : undefined,
    steps: kind === 'todo' ? steps(d) : undefined,
    free_text: kind === 'ask' ? { placeholder: 'Your answer' } : undefined,
    due_at: due ? new Date(due.at).toISOString() : undefined,
    default_key: due?.key,
    thread: th.length ? th : undefined,
    reply_unread: th.length > 0 && !th.at(-1)!.mine ? true : undefined,
  }
}

function ageWord(stamp: string): string {
  const m = minutes(stamp)
  if (m === undefined) return ''
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

function item(room: Room, i: Record) {
  return {
    id: i.get('id'),
    title: i.get('title'),
    owner_name: i.get('owner') || undefined,
    age_min: minutes(i.get('state') === 'doing' ? doingSince(i) || i.get('updated') : i.get('updated')),
    after: i.list('depends_on'),
    waits_on: i.section('Needs').split('\n').filter(Boolean).at(-1)?.replace(/^- \S+ [^:]+: /, ''),
  }
}

function lastActivity(room: Room): { min?: number; by?: string } {
  let best = { t: 0, by: '' }
  for (const r of [...room.items(), ...room.decisions()]) {
    const t = Date.parse(r.get('updated'))
    if (t > best.t) best = { t, by: r.section('Log').split('\n').filter(Boolean).at(-1)?.match(/^- \S+ ([^:]+):/)?.[1] ?? '' }
  }
  return best.t ? { min: Math.round((Date.now() - best.t) / 60_000), by: best.by || undefined } : {}
}

function summary(room: Room, st: RoomState) {
  const act = lastActivity(room)
  const oldest = st.needsYou.map(d => minutes(d.get('opened')) ?? 0).sort((a, b) => b - a)[0]
  return {
    name: room.name,
    title: room.brief.get('title') || room.name,
    status: st.status,
    sentence: st.sentence,
    action: st.action ? { kind: st.action, label: st.action === 'wake' ? 'Wake the lead' : 'Resume' } : undefined,
    cards: st.needsYou.length,
    oldest_card_min: oldest,
    last_activity_min: act.min,
    last_activity_by: act.by,
    done_at: room.isClosed() ? room.brief.get('closed').split(' ')[0] : undefined,
  }
}

export function roomDetail(room: Room, st: RoomState, sessions: Session[]) {
  const items = room.items()
  const by = (s: string) => items.filter(i => i.get('state') === s)
  const lead = findSession(room.leadSession(), sessions)
  const decided = room
    .decisions()
    .filter(d => d.get('status') === 'final')
    .sort((a, b) => b.get('updated').localeCompare(a.get('updated')))
    .slice(0, 10)
    .map(d => {
      const ans = d.section('Answer').split('\n').filter(Boolean).at(-1) ?? ''
      const [key, who, at] = ans.split(' · ')
      return { id: d.get('id'), title: d.get('title'), answer_label: options(d).find(o => o.key === key)?.text ?? key ?? '', by: who ?? '', at: at ?? '', went_ahead: who === 'default' || undefined }
    })
  const ws = waves(items)
  const labels = ['Ready now', 'After those', 'Later']
  const blockedOnYou = new Set(st.needsYou.flatMap(d => d.list('blocks')))
  const head = room.head
  return {
    ...summary(room, st),
    phase: head.get('phase'),
    lead: {
      name: 'lead',
      session: lead?.id ?? (room.leadSession() ? room.leadSession().slice(0, 8) : undefined),
      session_name: lead?.name || undefined,
      state: isRunning(lead ?? room.leadSession(), sessions) ? (lead?.status === 'idle' ? 'idle' : 'working') : room.leadSession() ? (isEnded(lead ?? room.leadSession(), sessions) ? 'finished' : 'working') : 'unreachable',
      since_min: minutes(head.get('updated')) ?? 0,
    },
    work: {
      moving: by('doing').map(i => item(room, i)),
      review: by('review').map(i => item(room, i)),
      ready_unstaffed: items.filter(i => st.ready.includes(i.get('id'))).map(i => item(room, i)),
      waiting: [...by('blocked'), ...by('todo').filter(i => !st.ready.includes(i.get('id')) && !blockedOnYou.has(i.get('id')))].map(i => item(room, i)),
      blocked_on_you: items.filter(i => OPEN_ITEM.has(i.get('state')) && blockedOnYou.has(i.get('id'))).map(i => item(room, i)),
      done_count: by('done').length,
      open_count: items.filter(i => OPEN_ITEM.has(i.get('state'))).length,
    },
    team_roster: room.brief.section('Team').replace(/^One line per member: role, model tier, charter \(what it owns and what it does not\).$/, '').trim() || undefined,
    team: [...new Set(items.map(i => i.get('owner')).filter(Boolean)), ...(items.some(i => OPEN_ITEM.has(i.get('state')) && !i.get('owner')) ? ['Unassigned'] : [])].map(name => ({
      name,
      items: items.filter(i => OPEN_ITEM.has(i.get('state')) && (i.get('owner') || 'Unassigned') === name)
        .map(i => {
          const session = findSession(i.get('agent'), sessions)
          return { ...item(room, i), state: i.get('state'), tier: i.get('tier') || undefined,
            session: session?.id ?? (i.get('agent') ? i.get('agent').slice(0, 8) : undefined),
            session_state: isRunning(session ?? i.get('agent'), sessions) ? (session?.status === 'idle' ? 'idle' : session?.status === 'waiting' ? 'waiting for input' : 'working') : i.get('agent') ? (isEnded(session ?? i.get('agent'), sessions) ? 'finished' : 'working') : undefined }
        }),
    })),
    plan: {
      waves: ws.map((w, k) => ({ label: labels[k] ?? `Wave ${k + 1}`, items: w })),
      critical: [] as string[],
      items: items.map(i => ({
        ...item(room, i),
        state: i.get('state'),
        summary: (i.section('Summary') || i.preamble.trim() || i.section('Acceptance'))
          .replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 400),
      })),
    },
    decided,
    lead_note: head.preamble.trim() ? { text: head.preamble.trim(), at: head.get('updated') } : undefined,
    attention: st.warnings.filter(w => /overrun|cycle|finished|ended|stuck/i.test(w)).map(w => ({ level: /hard|cycle/.test(w) ? 'loud' : 'warn', sentence: w })),
    paused: room.isPaused() ? { by: 'you', at: room.brief.get('paused') } : undefined,
  }
}

function recordJson(r: Record) {
  return {
    id: r.get('id'),
    title: r.get('title'),
    state: r.get('state') || r.get('status'),
    owner: r.get('owner') || r.get('decider'),
    why: r.section('Why it matters') || undefined,
    source: r.get('source') || undefined,
    thread: thread(r),
    history: r.section('Log').split('\n').filter(Boolean),
    sections: r.sections.filter(s => s[1].trim()).map(([h, text]) => ({ h, text: text.trim() })),
    file: basename(r.path),
  }
}

// ---- http -------------------------------------------------------------------

function send(req: IncomingMessage, res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const etag = `W/"${createHash('sha1').update(text).digest('hex').slice(0, 20)}"`
  if (code === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag })
    return res.end()
  }
  const headers: { [k: string]: string } = { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', ETag: etag }
  let out: Buffer | string = text
  if (text.length > 1024 && /gzip/.test(String(req.headers['accept-encoding'] ?? ''))) {
    out = gzipSync(text)
    headers['Content-Encoding'] = 'gzip'
  }
  res.writeHead(code, headers)
  res.end(out)
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 100_000) throw new Error('body too large')
  }
  return JSON.parse(raw || '{}')
}

export type ServeOptions = { port: number; host: string }

export async function serve(o: ServeOptions): Promise<void> {
  const users = (process.env.ROOMS_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(o.host)
  if (!users.length && !loopback) throw new Error('refusing to listen beyond loopback without ROOMS_USERS (the tailnet logins allowed to answer)')
  const readonly = process.env.ROOMS_READONLY === '1'
  const allowed = (req: IncomingMessage) => !readonly && (!users.length || users.includes(String(req.headers['tailscale-user-login'] ?? '')))

  let sessions: Session[] = listSessions()
  let sessionsAt = Date.now()
  const fresh = () => {
    if (Date.now() - sessionsAt > 10_000) {
      sessions = listSessions()
      sessionsAt = Date.now()
    }
    return sessions
  }
  if (!readonly) setInterval(() => {
    try {
      for (const line of sweep()) console.log(new Date().toISOString().slice(11, 19), line)
    } catch (e) {
      console.error('sweep:', (e as Error).message)
    }
  }, 15_000)

  const states = () => {
    const s = fresh()
    const ok: { room: Room; st: RoomState }[] = []
    const down: { name: string; error: string }[] = []
    for (const r of Room.all()) {
      const t = tryRoomState(r, { sessions: s })
      if ('st' in t) ok.push({ room: r, st: t.st })
      else down.push({ name: r.name, error: t.error })
    }
    return { ok, down }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && /^\/(rooms|tracker)$/.test(url.pathname)) {
        res.writeHead(308, { Location: url.pathname + '/' + url.search })
        return res.end()
      }
      const path = url.pathname.replace(/^\/(tracker|rooms)(?=\/|$)/, '') || '/'
      const parts = path.split('/').filter(Boolean)
      if (req.method === 'GET') {
        if (path === '/' || path === '/index.html') return send(req, res, 200, readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'), 'text/html')
        if (APP_FILES[path]) {
          res.writeHead(200, { 'Content-Type': APP_FILES[path], 'Cache-Control': 'no-cache' })
          return res.end(readFileSync(join(ROOT, 'web', path)))
        }
        if (path === '/api/inbox') {
          const all = states().ok
          const cards: ReturnType<typeof card>[] = []
          const going: ReturnType<typeof card>[] = []
          const waiting: { room: string; id: string; title: string; asked_at: string; who: string; text: string }[] = []
          const pulse: { [k: string]: number } = { moving: 0, waiting_outside: 0, stuck: 0, paused: 0, idle: 0, needs_you: 0 }
          const alarms = []
          for (const { room, st } of all) {
            if (st.status in pulse) pulse[st.status]++
            if (st.status === 'stuck') alarms.push({ room: room.name, room_title: room.brief.get('title') || room.name, kind: 'stuck', sentence: st.sentence, action: { kind: 'wake', label: 'Wake the lead' } })
            for (const d of st.needsYou) {
              const th = thread(d)
              if (th.length && th.at(-1)!.mine) waiting.push({ room: room.name, id: d.get('id'), title: d.get('title'), asked_at: th.at(-1)!.at, who: 'the lead', text: th.at(-1)!.text })
              else cards.push(card(room, d, st))
            }
            for (const d of room.decisions().filter(d => d.get('status') === 'provisional' && isHuman(d.get('decider')))) going.push(card(room, d, st))
          }
          cards.sort((a, b) => b.blocking_score - a.blocking_score || b.waiting_min - a.waiting_min)
          going.sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''))
          return send(req, res, 200, { now: new Date().toISOString(), count: cards.length, pulse, alarms, cards, going_ahead: going, waiting_on_team: waiting })
        }
        if (path === '/api/rooms') { const s = states(); return send(req, res, 200, { rooms_home: roomsHome(), rooms: [...s.ok.map(({ room, st }) => summary(room, st)), ...s.down.map(d => ({ name: d.name, title: d.name, status: 'unreachable', sentence: `On the hub, which is unreachable: ${d.error}`, cards: 0 }))] }) }
        if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
          const room = new Room(parts[2]).must()
          return send(req, res, 200, roomDetail(room, roomState(room, { sessions: fresh() }), fresh()))
        }
        if (parts[0] === 'api' && parts[1] === 'cards' && parts[2] && parts[3]) {
          const room = new Room(parts[2]).must()
          const r = parts[3] === 'PRD' ? room.prd() : room.find(parts[3])
          if (!r) return send(req, res, 404, { ok: false, error: 'no record' })
          return send(req, res, 200, recordJson(r))
        }
        if (path === '/api/receipts') return send(req, res, 200, receipts((url.searchParams.get('ids') ?? '').split(',').filter(Boolean)))
        return send(req, res, 404, { ok: false, error: 'not found' })
      }
      if (req.method !== 'POST') return send(req, res, 405, { ok: false, error: 'method' })
      if (!/json|text\/plain/.test(String(req.headers['content-type'] ?? ''))) return send(req, res, 415, { ok: false, error: 'JSON only' })
      if (!allowed(req)) return send(req, res, 403, { ok: false, error: 'not allowed' })
      const body = await readJson(req)
      if (parts[0] === 'api' && parts[1] === 'cards' && parts.length === 5) {
        const room = new Room(parts[2]).must()
        const id = parts[3]
        const verb = parts[4]
        const note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000)
        const d = room.find(id)
        if (!isHuman(d.get('decider'))) return send(req, res, 400, { ok: false, error: `${id} is the team's to decide` })
        if (verb === 'question') {
          const r = tapQuestion(room, id, String(body.text ?? body.note ?? ''))
          return send(req, res, 202, { ok: true, receipt_id: r.receipt })
        }
        if (verb === 'answer' || verb === 'stop') {
          let choice = String(body.choice ?? '')
          if (verb === 'stop') {
            if (d.get('status') !== 'provisional') return send(req, res, 400, { ok: false, error: `${id} is not going ahead` })
            if (!choice) {
              // Stop without a pick: it becomes an open card for the owner.
              d.set('status', 'open')
              d.set('default', '')
              d.set('due', '')
              d.save()
              const receipt = emit(room.name, `The owner stopped ${id} (${d.get('title')}) from going ahead with its default${note ? `: "${note}"` : ''}. It is an open card now; don't act on the default.`)
              return send(req, res, 202, { ok: true, receipt_id: receipt })
            }
          } else if (d.get('status') !== 'open' && d.get('status') !== 'final') return send(req, res, 400, { ok: false, error: `${id} is ${d.get('status')}` })
          if (choice === 'note' ? !note : !options(d).some(o => o.key === choice)) return send(req, res, 400, { ok: false, error: choice === 'note' ? 'write the answer first' : `${id} has no option '${choice}'` })
          try {
            const r = tapAnswer(room, id, { choice, by: 'human', source: verb === 'stop' ? 'stopped the default on the page' : 'tapped on the page', note: note || undefined }, verb === 'stop' ? undefined : body.if_match)
            if (body.resume_too && room.isPaused()) setPaused(room, false)
            return send(req, res, 202, { ok: true, receipt_id: r.receipt, already: r.already, message: r.message, delivery: r.already ? 'lead_read' : 'saved' })
          } catch (e) {
            if (e instanceof Conflict) return send(req, res, 409, { ok: false, error: e.message, changed: true })
            throw e
          }
        }
      }
      if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 4) {
        const room = new Room(parts[2]).must()
        if (parts[3] === 'pause') return send(req, res, 202, { ok: true, message: setPaused(room, !!body.paused) })
        if (parts[3] === 'close') return send(req, res, 202, { ok: true, message: closeRoom(room, 'closed by the owner on the page') })
        if (parts[3] === 'title') return send(req, res, 202, { ok: true, message: setTitle(room, String(body.title ?? '')) })
        if (parts[3] === 'wake') {
          const st = roomState(room, { sessions: fresh() })
          const note = String(body.note ?? '').trim()
          const receipt = emit(room.name, `The owner asked you to get room ${room.name} moving: it shows "${st.sentence}"${note ? ` Note: "${note}".` : ''} Dispatch the next item, ask the owner a real question, set waiting:/resume: in now-head.md, or close the room.`)
          return send(req, res, 202, { ok: true, receipt_id: receipt })
        }
      }
      return send(req, res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      return send(req, res, 400, { ok: false, error: (e as Error).message })
    }
  })
  await new Promise<void>(r => server.listen(o.port, o.host, r))
  console.log(`rooms page on http://${o.host}:${o.port}/ (rooms: ${roomsHome()})${readonly ? ', read-only' : ''}`)
  await new Promise(() => {})
}

export { recordAnswer }
