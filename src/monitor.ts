import { config } from './config.ts'
import type { Room } from './room.ts'
import { type Session, listSessions } from './sessions.ts'
import { workerOf } from './workers.ts'
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
    return i.get('state') === 'doing' && !!agent && workerOf(room.name, i, sessions).live === 'alive'
  })
  const ready = readyUnstaffed(room)
  const held = heldItems(room, ready)
  const byRole = new Map<string, string[]>()
  for (const id of ready.filter(id => !held.has(id))) {
    const role = roleOf(room.find(id).get('owner'))
    byRole.set(role, [...(byRole.get(role) ?? []), id])
  }
  // Clone names are recorded on the item at spawn, so the next clone never reuses one.
  const taken = new Set(items.map(i => i.get('clone')).filter(Boolean))
  const clones: Clone[] = []
  const queued: string[] = []
  let free = Math.max(0, maxThreads - running.length)
  // At the cap nothing can start, so every ready item waits for a thread.
  if (!free) return { running: running.length, max: maxThreads, clones, queued: [...byRole.values()].flat() }
  // An idle role's own first item takes a thread before any clone does.
  const rest = new Map<string, string[]>()
  for (const [role, ids] of byRole) {
    if (running.some(i => roleOf(i.get('owner')) === role)) { rest.set(role, ids); continue }
    if (free > 0) free--
    else queued.push(ids[0])
    rest.set(role, ids.slice(1))
  }
  // Only the excess over queueLimit gets clones; the others wait behind the role.
  for (const [role, ids] of rest) {
    let n = 1
    for (const id of ids.slice(queueLimit)) {
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
