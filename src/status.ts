import { isRouted } from './backend.ts'
import { editDir } from './working.ts'
import { Record } from './record.ts'
import { OPEN_ITEM, Room } from './room.ts'
import { type RoomState, isHuman, waves, readyUnstaffed, openCards } from './state.ts'
import { options } from './answer.ts'
import { lastPush, uncommitted } from './git.ts'
import { pending } from './events.ts'

// The room as text, computed on demand (nothing generated is committed).
// `brief` is the short digest a one-shot lead or a fresh session starts from.

const rule = '-'.repeat(48)

function ago(stamp: string): string {
  const t = Date.parse(stamp)
  if (!Number.isFinite(t)) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`
}

export function statusText(room: Room, st: RoomState, brief = false): string {
  const b = room.brief
  const head = room.head
  const items = room.items()
  const decisions = room.decisions()
  const out: string[] = [`${(b.get('title') || room.name).toUpperCase()} · ${room.name}`, st.line]
  const prd = room.prd()
  if (prd) {
    const rfs = room.refinements().filter(r => r.get('status') === 'agreed').map(r => r.get('id'))
    out.push(`PRD ${prd.get('status')}${rfs.length ? ` + ${rfs.join(', ')}` : ''}${room.buildLocked() ? ' · building locked (research items only)' : ''}`)
  }
  if (head.get('phase')) out.push(`phase: ${head.get('phase')}`)
  if (isRouted(room.name)) out.push(`on the hub: edit BRIEF.md, now-head.md, notes/ and decisions/ in ${editDir(room)}; any rooms command takes the edits to the hub`)
  const evs = pending(room.name)
  if (evs.length) out.push(`${evs.length} undelivered event(s) for the lead`)
  out.push(rule)

  out.push(`OWNER CARDS (${st.needsYou.length})`)
  for (const d of st.needsYou) {
    out.push(`  ${d.get('id')} ${d.get('title')}${d.get('door') === 'one' && ['decision', 'prd'].includes(d.get('type')) ? ' [one-way]' : ''} · waiting ${ago(d.get('opened'))}`)
    if (!brief) for (const o of options(d)) out.push(`      ${o.key}) ${o.text}`)
    const q = d.section('Questions').split('\n').filter(Boolean).at(-1)
    if (q?.startsWith('- Q')) out.push(`      unanswered question: ${q.slice(2)}`)
  }
  const prov = decisions.filter(d => d.get('status') === 'provisional')
  if (prov.length) {
    out.push('GOING AHEAD UNLESS THE OWNER STOPS IT')
    for (const d of prov) out.push(`  ${d.get('id')} ${d.get('title')} → ${d.get('default')} at ${d.get('due') || '?'}`)
  }
  const team = decisions.filter(d => d.get('status') === 'open' && !isHuman(d.get('decider')))
  if (team.length) {
    out.push('OPEN, TEAM DECIDES')
    for (const d of team) out.push(`  ${d.get('id')} ${d.get('title')} (${d.get('decider')})`)
  }

  const open = items.filter(i => OPEN_ITEM.has(i.get('state')))
  const done = items.filter(i => i.get('state') === 'done').length
  out.push(rule, `WORK: ${open.length} open, ${done} done`)
  if (!brief) waves(items).forEach((w, k) => out.push(`  wave ${k}: ${w.join(' ')}`))
  const order = ['blocked', 'doing', 'review', 'todo']
  const byId = new Map(items.map(i => [i.get('id'), i]))
  for (const i of open.sort((a, c) => order.indexOf(a.get('state')) - order.indexOf(c.get('state')))) {
    let s = i.get('state')
    if (s === 'todo') {
      const waits = i.list('depends_on').filter(d => !['done', 'dropped'].includes(byId.get(d)?.get('state') ?? ''))
      s = waits.length ? `waits ${waits.join(',')}` : st.ready.includes(i.get('id')) ? 'READY' : 'todo'
    }
    const kind = i.get('kind') === 'research' ? ' (research)' : ''
    out.push(`  ${i.get('id').padEnd(4)} ${(i.get('title') + kind).slice(0, 34).padEnd(34)} ${i.get('owner').slice(0, 10).padEnd(10)} ${s}`)
  }
  const note = head.preamble.trim()
  if (note && !brief) out.push(rule, 'LEAD NOTE', ...note.split('\n'))
  const since = head.get('since')
  if (since && !brief) {
    const fresh = [...decisions.filter(d => d.get('status') === 'final'), ...items.filter(i => ['done', 'dropped'].includes(i.get('state')))].filter(r => r.get('updated') > since)
    if (fresh.length) out.push(rule, `SINCE THE OWNER'S LAST MESSAGE (${since.slice(11, 16)})`, ...fresh.map(r => `  ${r.get('id')} ${r.get('title')} (${r.get('state') || r.section('Answer').split('\n').at(-1)})`))
  }
  const dirty = uncommitted(room.name)
  const push = lastPush()
  if (push && !push.ok) st.warnings.push(`mirror push failing since ${new Date(push.at).toISOString().slice(11, 16)}Z: ${push.error.split('\n')[0]}`)
  if (dirty > 20) st.warnings.push(`${dirty} uncommitted files (the page server commits; is it running?)`)
  if (st.warnings.length) out.push(rule, 'FOR THE LEAD', ...st.warnings.map(w => `  ${w}`))
  return out.join('\n')
}

export function cardLine(d: Record): string {
  return `${d.get('id')} ${d.get('title')}`
}

// Cheap enough for the status bar: record reads only, no session subprocesses.
export function roomStatusLine(room: Room): string {
  const items = room.items(), cardsOpen = openCards(room);
  const blockedByOwner = new Set(cardsOpen.flatMap(c => c.list('blocks')));
  const ready = readyUnstaffed(room).filter(id => !blockedByOwner.has(id));
  const count = (state: string) => items.filter(i => i.get('state') === state).length;
  const moving = count('doing'), review = count('review');
  const waiting = count('blocked') + items.filter(i => i.get('state') === 'todo' && !ready.includes(i.get('id'))).length;
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim();
  const next = items.find(i => ready.includes(i.get('id')));
  const cards = cardsOpen.length;
  const parts = [clean(room.name), `${moving} moving`, `${waiting} waiting`];
  if (review) parts.push(`${review} in review`);
  if (cards) parts.push(`${cards} need you`);
  if (room.isClosed()) parts.push('done');
  else if (room.isPaused()) parts.push('paused');
  else if (next) parts.push(`next: ${next.get('id')} ${clean(next.get('title')).slice(0, 48)}`);
  else parts.push('next: none ready');
  return parts.join(' · ');
}
