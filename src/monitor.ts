import { config } from './config.ts'
import type { Room } from './room.ts'
import { type Session, findSession, isRunning, listSessions } from './sessions.ts'
import { heldItems, readyUnstaffed } from './state.ts'

// The hall monitor. A team member is an item `owner` role and takes one item
// at a time. When more parallel-ready items wait for one role than
// hallMonitor.queueLimit allows, the extras go to clones of that role
// ("dev 2", "dev 3"), but never more than hallMonitor.maxThreads workers run
// in a room at once.

export type Clone = { item: string; name: string }
export type Plan = { running: number; max: number; clones: Clone[]; queued: string[] }

const roleOf = (owner: string) => owner || 'worker'

export function hallMonitor(room: Room, sessions: Session[] = listSessions()): Plan {
  const { maxThreads, queueLimit } = config().hallMonitor
  const items = room.items()
  const running = items.filter(i => {
    const agent = i.get('agent')
    return i.get('state') === 'doing' && !!agent && isRunning(findSession(agent, sessions) ?? agent, sessions)
  })
  const ready = readyUnstaffed(room)
  const held = heldItems(room, ready)
  const byRole = new Map<string, string[]>()
  for (const id of ready.filter(id => !held.has(id))) {
    const role = roleOf(room.find(id).get('owner'))
    byRole.set(role, [...(byRole.get(role) ?? []), id])
  }
  const taken = new Set(items.filter(i => i.get('agent')).map(i => i.get('owner')))
  // An idle role's own first item takes a thread too, before any clone does.
  const idle = [...byRole.keys()].filter(role => !running.some(i => roleOf(i.get('owner')) === role)).length
  let free = Math.max(0, maxThreads - running.length - idle)
  const clones: Clone[] = []
  const queued: string[] = []
  for (const [role, ids] of byRole) {
    const busy = running.some(i => roleOf(i.get('owner')) === role)
    // An idle member takes the first item itself; the rest wait behind it.
    const behind = ids.slice(busy ? 0 : 1)
    if (behind.length <= queueLimit) continue
    let n = 1
    for (const id of behind) {
      if (free <= 0) {
        queued.push(id)
        continue
      }
      while (taken.has(`${role} ${++n}`)) {}
      taken.add(`${role} ${n}`)
      clones.push({ item: id, name: `${role} ${n}` })
      free--
    }
  }
  return { running: running.length, max: maxThreads, clones, queued }
}
