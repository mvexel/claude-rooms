import type { EngineInterface, Register } from 'claude-code'

// The rooms plugin, in every session, doing only what that session's role
// calls for (asked of the CLI: `rooms hook poll` says who this session is).
//
// Lead: holds the room's lease, so the tracker knows events reach it here.
//   Between tool calls it takes waiting events and hands them to the model as
//   context of the tool result (no extra turn); when idle it submits them as
//   one prompt. "D05 b" in the owner's message is recorded before the model
//   reads it.
// Worker: the same delivery for messages to its item; when its turn ends,
//   the CLI checks whether it reported, and if not, the lead hears so.
// Elsewhere: nothing.

const POLL_MS = 5000
const WHO_MS = 60000

type Me = { room?: string; role?: string; item?: string; events?: string; status_line?: string }

// Module state; a reload starts it over, which is harmless.
let me: Me = {}
let whoAt = 0
let busy = false
let polling = false
let midAt = 0
const MID_MS = 10000
// Set at start when this session's sandbox can't write the rooms home; said
// once, on the first prompt that has to do with rooms.
let sandboxNote = ''

async function cli($: EngineInterface, args: string[]) {
  const bin = (await $.env.get('CLAUDE_ROOMS_CLI')) || 'rooms'
  const id = await $.session.id()
  return $.process.run([bin, ...args, '--session', id], { timeoutMs: 20000 })
}

// Ask the CLI who this session is; as lead, also beat the lease and
// optionally take the events.
async function poll($: EngineInterface, take: boolean, refresh = false): Promise<string> {
  const now = await $.clock.now()
  if (!refresh && !take && !me.room && now - whoAt < WHO_MS) return ''
  whoAt = now
  const r = await cli($, ['hook', 'poll', ...(take ? ['--take'] : [])])
  if (r.exitCode !== 0) return ''
  try {
    me = JSON.parse(r.stdout)
  } catch {
    me = {}
  }
  $.ui.status(me.room ? `Room · ${me.status_line || me.room}${me.item ? ` · ${me.role} ${me.item}` : ''}` : undefined)
  return me.events ?? ''
}

async function idleTick($: EngineInterface) {
  if (busy || polling) return
  polling = true
  try {
    const text = await poll($, !!me.room)
    if (text) await $.prompt.submit({ text })
  } finally {
    polling = false
  }
}

async function roomCommand($: EngineInterface, raw: string) {
  const args = raw.trim() ? raw.trim().split(/\s+/) : me.room ? ['status', me.room] : ['status']
  const bin = (await $.env.get('CLAUDE_ROOMS_CLI')) || 'rooms'
  const r = await $.process.run([bin, ...args], { timeoutMs: 30000 })
  return { text: (r.stdout || r.stderr).trim() || `rooms exited ${r.exitCode}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'room', description: "This session's room status, or any rooms command: /room status, /room help" })
    $.clock.every(POLL_MS, () => void idleTick($).catch(() => {}))
    void poll($, false).catch(() => {})
    void cli($, ['hook', 'check']).then(r => { sandboxNote = r.exitCode === 0 ? r.stdout.trim() : '' }).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    busy = false
    if (me.item) void cli($, ['hook', 'stop']).catch(() => {})
    void idleTick($).catch(() => {})
    return r
  })

  // Mid-turn delivery for the lead: events ride along with a tool result.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!me.room || r.deny !== undefined || r.isError) return r
    const now = await $.clock.now()
    if (now - midAt < MID_MS) return r
    midAt = now
    const text = await poll($, true).catch(() => '')
    return text ? { ...r, context: [...(r.context ?? []), text] } : r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // The organization's sec-default guard skips prompt.compose hooks from
    // user plugins. Add our own context at submission, which it permits.
    // Refresh even outside a room: this session may just have become a lead,
    // and the asynchronous startup poll may not have finished yet.
    const mail = await poll($, false, true).catch(() => '')
    if (mail) e = { ...e, context: [...(e.context ?? []), mail] }
    if (sandboxNote && (me.room || /\brooms?\b/i.test(e.text))) {
      e = { ...e, context: [...(e.context ?? []), sandboxNote] }
      sandboxNote = ''
    }
    if (me.room) {
      const place = me.role === 'lead'
        ? `You lead room ${me.room} (claude-rooms). Follow the rooms:lead skill. Updates for you arrive as "[rooms]" notes; the record, not this conversation, is the memory: when unsure, run rooms status ${me.room}.`
        : `You work on ${me.item} in room ${me.room} (claude-rooms). Follow the rooms:worker skill; finish with rooms done ${me.room} ${me.item}.`
      e = { ...e, context: [...(e.context ?? []), place] }
    }
    if (me.role !== 'lead' || e.origin?.kind === 'plugin' || !/\b[DAP]\d{2,}\s+[a-e]\b/.test(e.text)) return next(e)
    const r = await cli($, ['hook', 'prompt', '--said', e.text])
    const note = r.exitCode === 0 ? r.stdout.trim() : ''
    return next(note ? { ...e, text: `${e.text}\n\n${note}` } : e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'room' }, async ($, e) => roomCommand($, e.args))
}
