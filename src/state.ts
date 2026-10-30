import { Record } from './record.ts'
import { OPEN_ITEM, Room } from './room.ts'
import { type Session, findSession, isEnded, isRunning, listSessions, liveness } from './sessions.ts'
import { leaseFresh, pending, turnRunning } from './events.ts'

// One status per room, decided here and nowhere else. For the owner it is a
// sentence and at most one action; for the lead, the same plus warnings.
//
//   stuck            work is ready (or events wait) and nothing will start it
//   needs_you        cards wait on the owner
//   paused           the owner paused it
//   waiting_outside  now-head `waiting:` with a `resume:` still ahead
//   moving           an agent is working
//   idle             nothing open, nothing asked; fine
//   done             closed
// Precedence is that order, except a closed or paused room with open cards
// still shows needs_you.

export type Status = 'needs_you' | 'moving' | 'waiting_outside' | 'stuck' | 'paused' | 'idle' | 'done'

export type RoomState = {
  status: Status
  sentence: string // to the owner: what's true, then why
  action?: 'wake' | 'resume'
  line: string // compact, for the CLI footer
  needsYou: Record[]
  moving: string[]
  ready: string[]
  warnings: string[] // to the lead
}

export function isHuman(decider: string): boolean {
  const alias = process.env.ROOMS_HUMAN
  return decider === 'human' || decider === 'owner' || (!!alias && decider === alias)
}

export function openCards(room: Room): Record[] {
  return room
    .decisions()
    .filter(d => d.get('status') === 'open' && isHuman(d.get('decider')))
    .sort((a, b) => cardRank(room, b) - cardRank(room, a))
}

// Most blocking first: urgent, then how much open work waits downstream.
export function cardRank(room: Room, d: Record): number {
  const open = room.items().filter(i => OPEN_ITEM.has(i.get('state')))
  const reached = new Set(d.list('blocks').filter(b => open.some(i => i.get('id') === b)))
  for (let grew = true; grew; ) {
    grew = false
    for (const i of open)
      if (!reached.has(i.get('id')) && i.list('depends_on').some(x => reached.has(x))) {
        reached.add(i.get('id'))
        grew = true
      }
  }
  const hours = open.filter(i => reached.has(i.get('id'))).reduce((h, i) => h + (Number(i.get('cap_h')) || 1), 0)
  return (d.get('urgent') ? 10_000 : 0) + reached.size * 100 + hours
}

function hoursSince(stamp: string): number {
  const t = Date.parse(stamp)
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : 0
}

// When an item last went to `doing`, from its Log.
export function doingSince(item: Record): string {
  const log = item.section('Log').split('\n')
  const day = item.get('updated').slice(0, 10)
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].match(/^- (\d\d:\d\d)Z .*state=doing/)
    if (m) return `${day}T${m[1]}:00Z`
  }
  return ''
}

export function readyUnstaffed(room: Room): string[] {
  const items = room.items()
  const done = new Set(items.filter(i => ['done', 'dropped'].includes(i.get('state'))).map(i => i.get('id')))
  return items
    .filter(i => i.get('state') === 'todo' && !i.get('agent') && i.list('depends_on').every(d => done.has(d)))
    .filter(i => !(room.buildLocked() && i.get('kind') !== 'research'))
    .map(i => i.get('id'))
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function age(stamp: string): string {
  const m = Math.round((Date.now() - Date.parse(stamp)) / 60_000)
  if (!Number.isFinite(m)) return ''
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)} days`
}

export function roomState(room: Room, opts: { yielding?: boolean; sessions?: Session[] } = {}): RoomState {
  const sessions = opts.sessions ?? listSessions()
  const brief = room.brief
  const items = room.items()
  const byId = new Map(items.map(i => [i.get('id'), i]))
  const needsYou = openCards(room)
  const warnings: string[] = []
  const moving: string[] = []
  const finishedQuiet: string[] = []
  const unknownLive: string[] = []

  for (const it of items) {
    const id = it.get('id')
    const st = it.get('state')
    if (!OPEN_ITEM.has(st)) continue
    if (st === 'doing') {
      const s = it.get('agent') ? findSession(it.get('agent'), sessions) : undefined
      const agent = it.get('agent')
      const alive = !!agent && isRunning(s ?? agent, sessions)
      if (alive && s?.status !== 'idle') moving.push(id)
      else if (alive) {
        finishedQuiet.push(id)
        warnings.push(`${id} doing, but its worker is idle: read its result or tell it what is missing`)
      } else if (agent && !isEnded(s ?? agent, sessions)) {
        unknownLive.push(id)
        warnings.push(`${id} doing, worker liveness unknown (sessions hidden from this process, e.g. by a sandbox); not treating it as ended`)
      } else if (it.get('agent')) {
        finishedQuiet.push(id)
        warnings.push(`${id} doing, but its worker session ended`)
      } else warnings.push(`${id} doing with no agent (rooms spawn ${room.name} ${id})`)
      const cap = Number(it.get('cap_h'))
      const since = doingSince(it)
      if (cap && since) {
        const h = hoursSince(since)
        if (h > cap * 1.5) warnings.push(`${id} hard overrun: ${h.toFixed(1)}h of ${cap}h; stop and re-plan`)
        else if (h > cap) warnings.push(`${id} overrun: ${h.toFixed(1)}h of ${cap}h`)
      }
      for (const dep of it.list('depends_on')) {
        const d = byId.get(dep)
        if (d && !['done', 'dropped'].includes(d.get('state'))) warnings.push(`${id} doing but ${dep} is ${d.get('state')}`)
      }
    }
    if (st === 'review' && hoursSince(it.get('updated')) > 1) warnings.push(`${id} in review for ${hoursSince(it.get('updated')).toFixed(1)}h: review it or mark it done`)
    if (st === 'blocked' && it.section('Needs')) warnings.push(`${id} blocked on a need: decide it`)
    for (const dep of it.list('depends_on')) if (!byId.has(dep)) warnings.push(`${id} depends on unknown ${dep}`)
  }
  const cycle = findCycle(items)
  if (cycle) warnings.push(`dependency cycle: ${cycle.join(' → ')}`)
  const ready = readyUnstaffed(room)
  const waitingEvents = pending(room.name)

  const base = { needsYou, moving, ready, warnings }
  const cards = needsYou.length
  const cardSentence = cards
    ? `${plural(cards, 'card')} waiting on you, oldest ${age(needsYou.map(d => d.get('opened')).sort()[0])}`
    : ''

  if (room.isClosed()) {
    if (cards) return { ...base, status: 'needs_you', sentence: `${cardSentence}. The room is done; answering is recorded but wakes no one.`, line: `Closed, ${cards} open card(s)` }
    return { ...base, status: 'done', sentence: `Done: ${brief.get('closed').replace(/^\S+\s*/, '')}`, line: `Closed: ${brief.get('closed')}` }
  }
  if (room.isPaused()) {
    const since = brief.get('paused')
    if (cards) return { ...base, status: 'needs_you', sentence: `${cardSentence}. The room is paused; the lead picks answers up when you resume.`, action: 'resume', line: `Paused, needs you: ${needsYou.map(d => d.get('id')).join(' ')}` }
    return { ...base, status: 'paused', sentence: `Paused by you ${age(since)} ago.`, action: 'resume', line: 'Paused' }
  }

  const lead = findSession(room.leadSession(), sessions)
  const leadLive = isRunning(lead ?? room.leadSession(), sessions)
  const leadWorking = !opts.yielding && ((leadLive && lead?.status !== 'idle') || !!turnRunning(room.name))
  const heldEvents = waitingEvents.length > 0 && !leaseFresh(room) && leadLive
  const leadUnknown = !!room.leadSession() && !leadLive && !isEnded(lead ?? room.leadSession(), sessions)
  const stuckWhy =
    unknownLive.length || leadUnknown ? '' : heldEvents
      ? `${plural(waitingEvents.length, 'update')} for the lead can't reach it: its session is open but not checking in (no rooms plugin there, or rooms serve is older than the plugin: restart it).`
      : !moving.length && !leadWorking && finishedQuiet.length
        ? `${finishedQuiet.join(', ')} finished without reporting back, and nothing else is running.`
        : !moving.length && !leadWorking && ready.length
          ? `${plural(ready.length, 'item is', 'items are')} ready but nobody is working on them.`
          : ''
  if (stuckWhy) return { ...base, status: 'stuck', sentence: stuckWhy, action: 'wake', line: `STUCK: ${stuckWhy}` }
  if (cards) return { ...base, status: 'needs_you', sentence: `${cardSentence}.`, line: `Needs you: ${needsYou.map(d => d.get('id')).join(' ')}` }

  const head = room.head
  const waiting = head.get('waiting')
  const resume = head.get('resume')
  if (waiting) {
    const at = Date.parse(resume)
    if (!Number.isFinite(at) || at > Date.now()) return { ...base, status: 'waiting_outside', sentence: `Waiting on ${waiting}${resume ? `; picks up again ${resume}` : ''}.`, line: `Waiting on: ${waiting}${resume ? `, resumes ${resume}` : ''}` }
    warnings.push(`resume time ${resume} has passed`)
  }
  if (moving.length || leadWorking) {
    const who = moving.map(id => `${byId.get(id)!.get('owner') || 'a worker'} on ${id}`)
    const sentence = who.length ? `${who.join(', ')}${ready.length ? ` · ${ready.length} queued` : ''}.` : 'The lead is working.'
    return { ...base, status: 'moving', sentence, line: `Moving: ${[...moving, ...(leadWorking ? ['lead'] : [])].join(' ')}` }
  }
  const open = items.filter(i => OPEN_ITEM.has(i.get('state')))
  if (open.length) {
    const why = `${plural(open.length, 'open item')}, but nothing is running or waiting on you.`
    return { ...base, status: 'stuck', sentence: why, action: 'wake', line: `STUCK: ${why}` }
  }
  return { ...base, status: 'idle', sentence: 'Nothing open; the room waits for its next piece of work.', line: 'Idle' }
}

function findCycle(items: Record[]): string[] | undefined {
  const deps = new Map(items.map(i => [i.get('id'), i.list('depends_on')]))
  const seen = new Set<string>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    const at = stack.indexOf(id)
    if (at >= 0) return [...stack.slice(at), id]
    if (seen.has(id)) return
    seen.add(id)
    stack.push(id)
    for (const d of deps.get(id) ?? []) {
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
  }
  for (const id of deps.keys()) {
    const c = visit(id)
    if (c) return c
  }
}

// Waves: items whose dependencies are all done or in earlier waves.
export function waves(items: Record[]): string[][] {
  const live = items.filter(i => i.get('state') !== 'dropped')
  const done = new Set(live.filter(i => i.get('state') === 'done').map(i => i.get('id')))
  const left = live.filter(i => !done.has(i.get('id')))
  const out: string[][] = []
  const placed = new Set(done)
  while (left.length) {
    const wave = left.filter(i => i.list('depends_on').every(d => placed.has(d) || !live.some(o => o.get('id') === d)))
    if (!wave.length) {
      out.push(left.map(i => i.get('id')))
      break
    }
    for (const w of wave) {
      placed.add(w.get('id'))
      left.splice(left.indexOf(w), 1)
    }
    out.push(wave.map(i => i.get('id')))
  }
  return out
}
