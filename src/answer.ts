import { Record, hhmm, now } from './record.ts'
import { OPEN_ITEM, Room } from './room.ts'
import { autocommit } from './git.ts'
import { config } from './config.ts'
import { emit } from './events.ts'
import { withLock } from './git.ts'

// Answering a card. Three paths share recordAnswer: the lead in chat (or the
// plugin hook that catches "D05 b" in the owner's message), a tap on the page,
// and a provisional default coming due. Only the page and the default emit an
// event for the lead; in chat the lead already knows.

export type AnswerInput = { choice: string; by: string; source?: string; quote?: string; note?: string }

export function answerLine(a: AnswerInput): string {
  const parts = [a.choice, a.by, hhmm().slice(0, 5)]
  if (a.source) parts.push(a.source)
  if (a.quote) parts.push(`"${a.quote.replace(/"/g, "'")}"`)
  if (a.note) parts.push(`note: "${a.note.replace(/"/g, "'")}"`)
  return parts.join(' · ')
}

export function options(d: Record): { key: string; text: string }[] {
  return d
    .section('Options')
    .split('\n')
    .map(l => l.match(/^([a-z])\)[ \t]*(\S.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ key: m[1], text: m[2].replace(/\.$/, '') }))
}

export function optionText(d: Record, letter: string): string {
  return options(d).find(o => o.key === letter)?.text ?? ''
}

export function recordAnswer(room: Room, id: string, a: AnswerInput): string {
  const d = room.find(id)
  d.appendTo('Answer', answerLine(a))
  d.set('status', 'final')
  d.set('updated', now())
  d.save()
  const effect = afterAnswer(room, d, a.choice)
  autocommit(`${room.name}: ${id} ${a.choice} (${a.by})`, config().commitDebounceMs)
  return effect
}

function signOff(r: Record, line: string): void {
  const s = r.section('Sign-off')
  if (/^Owner:[ \t]*$/m.test(s)) r.setSection('Sign-off', s.replace(/^Owner:[ \t]*$/m, line))
  else r.appendTo('Sign-off', line)
}

export function afterAnswer(room: Room, d: Record, choice: string): string {
  const type = d.get('type')
  const id = d.get('id')
  if (type === 'prd') {
    const prd = room.prd()
    if (!prd) return `${id} answered; no PRD.md`
    if (choice === 'a') {
      prd.set('status', 'agreed')
      prd.set('agreed', now())
      signOff(prd, `Owner: agreed at ${hhmm()} (${id})`)
      prd.save()
      return 'PRD agreed: building is open.'
    }
    prd.set('status', 'draft')
    prd.save()
    return `PRD back to draft: revise it and run rooms prd ${room.name} review again.`
  }
  if (type === 'refinement') {
    const rfId = d.get('source').replace(/"/g, '')
    const rf = room.find(rfId)
    if (choice === 'a') {
      rf.set('status', 'agreed')
      rf.set('agreed', `${now()} by owner, ${id} a`)
      signOff(rf, `Owner: agreed at ${hhmm()} (${id})`)
      rf.save()
      for (const old of rf.list('supersedes')) {
        const o = room.find(old)
        if (o.get('status') === 'agreed') {
          o.set('status', 'superseded')
          o.save()
        }
      }
      return `${rfId} agreed: it is now binding.`
    }
    rf.set('status', 'draft')
    rf.save()
    return `${rfId} back to draft.`
  }
  const t = optionText(d, choice)
  return `${id}: ${choice}${t ? `) ${t}` : ''}.`
}

function unblocks(room: Room, d: Record): string[] {
  const open = new Set(room.items().filter(i => OPEN_ITEM.has(i.get('state'))).map(i => i.get('id')))
  return d.list('blocks').filter(b => open.has(b))
}

export class Conflict extends Error {}

// The page path. if_match is the card's `updated` as the page saw it: a card
// that changed since is not answered blind.
export function tapAnswer(room: Room, id: string, a: AnswerInput, ifMatch?: string): { message: string; receipt?: string; already?: boolean } {
  return withLock(`answer-${room.name}`, () => {
    const d = room.find(id)
    if (d.get('status') === 'final') return { message: `${id} was already answered`, already: true }
    if (ifMatch && d.get('updated') !== ifMatch) throw new Conflict(`${id} changed since you saw it`)
    const effect = recordAnswer(room, id, a)
    const opt = optionText(d, a.choice)
    const what = a.choice === 'note' ? `wrote: "${a.note}"` : `${a.choice}) ${opt}${a.note ? ` · note: "${a.note}"` : ''}`
    const ub = unblocks(room, d)
    const receipt = emit(
      room.name,
      `The owner answered ${id} (${d.get('title')}): ${what}. ${effect}${ub.length ? ` It unblocks ${ub.join(', ')}.` : ''} Act on it now; it is already recorded.`,
    )
    return { message: effect, receipt }
  })
}

export function tapQuestion(room: Room, id: string, text: string): { receipt: string } {
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 1000)
  if (!q) throw new Error('write the question first')
  const d = room.find(id)
  d.appendTo('Questions', `- Q · owner · ${hhmm().slice(0, 5)}: "${q.replace(/"/g, "'")}"`)
  d.set('updated', now())
  d.save()
  autocommit(`${room.name}: question on ${id}`, config().commitDebounceMs)
  const receipt = emit(
    room.name,
    `The owner asked a question on ${id} (${d.get('title')}) instead of answering: "${q}". The card stays open. Reply with: rooms answer ${room.name} ${id} --reply "<answer>", and fix the options if your answer changes them. Do not answer the card yourself.`,
  )
  return { receipt }
}

// ---- provisional defaults ---------------------------------------------------

// `default: b` plus `due: <stamp>`; also reads the older "b at 03:30Z" form.
export function dueOf(d: Record): { key: string; at: number } | undefined {
  const def = d.get('default').replace(/"/g, '').trim()
  if (!def) return
  const m = def.match(/^([a-z])(?:\s+at\s+(\d\d:\d\dZ))?$/)
  if (!m) return
  let at = Date.parse(d.get('due'))
  if (!Number.isFinite(at) && m[2]) at = Date.parse(`${d.get('opened').slice(0, 10)}T${m[2].replace('Z', ':00Z')}`)
  return Number.isFinite(at) ? { key: m[1], at } : undefined
}

export function applyDueDefaults(room: Room): string[] {
  if (room.isClosed() || room.isPaused()) return []
  const applied: string[] = []
  for (const d of room.decisions()) {
    if (d.get('status') !== 'provisional') continue
    const due = dueOf(d)
    if (!due || due.at > Date.now()) continue
    const effect = recordAnswer(room, d.get('id'), { choice: due.key, by: 'default', source: 'went ahead by default' })
    emit(room.name, `${d.get('id')} (${d.get('title')}) went ahead with its default: ${effect}`)
    applied.push(d.get('id'))
  }
  return applied
}
