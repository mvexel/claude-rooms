import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { roomsHome, stateDir } from './config.ts'

// Where room records and runtime state (inboxes, leases, receipts) are stored.
// Every read and write of them goes through one Backend. The default keeps
// plain files under ROOMS_HOME and STATE; CLAUDE_ROOMS_BACKEND=<module path>
// swaps in another implementation.
//
// Keys are absolute paths, as the local files backend would use them
// (ROOMS_HOME/<room>/items/T01-x.md, STATE/rooms/<room>/inbox.jsonl). All
// methods are synchronous, as the callers are. Writes create missing parents.
// Not behind the seam, because they are about this machine: locks, git,
// worker scratch folders, sessions, config and the sandbox settings.

export interface Backend {
  read(path: string): string | undefined // undefined when it does not exist
  write(path: string, text: string): void // replaces; readers never see half a file
  append(path: string, text: string): void
  exists(path: string): boolean
  list(dir: string): { name: string; dir: boolean }[] // [] when the dir does not exist
  remove(path: string): void // a file or a whole folder; missing is fine
  claim(path: string): string | undefined // take a file's text and remove it, once, for one caller
}

export const localBackend: Backend = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.${process.pid}.tmp`, text)
    renameSync(`${path}.${process.pid}.tmp`, path)
  },
  append(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, text)
  },
  exists: existsSync,
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() }))
    } catch {
      return []
    }
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true })
  },
  claim(path) {
    const claimed = `${path}.${process.pid}.taking`
    try {
      renameSync(path, claimed)
    } catch {
      return undefined
    }
    const text = readFileSync(claimed, 'utf8')
    unlinkSync(claimed)
    return text
  },
}

let current: Backend = localBackend

export function backend(): Backend {
  return current
}

const METHODS = ['read', 'write', 'append', 'exists', 'list', 'remove', 'claim']

async function importBackend(spec: string, what: string, settings?: unknown): Promise<Backend> {
  const url = /^[a-z]+:/i.test(spec) && !isAbsolute(spec) ? spec : pathToFileURL(resolve(spec)).href
  const mod = await import(url)
  const b = typeof mod.default === 'function' ? await mod.default(settings) : mod.default
  for (const m of METHODS) if (typeof b?.[m] !== 'function') throw new Error(`${what} ${spec}: default export has no ${m}()`)
  return b
}

// Per-host routing file, STATE/backend.json:
//   { "module": "/path/to/backend.ts", "rooms": ["room-a"], "settings": { ... } }
// Every key of a listed room (ROOMS_HOME/<room>/..., STATE/rooms/<room>/...)
// goes to the module (called with `settings`); everything else stays on local
// files. Remove a room from the list and it is local again.
export type Routing = { module: string; rooms: string[]; settings?: unknown }

export function routingFile(): string {
  return join(stateDir(), 'backend.json')
}

// The room names last read from a good routing file, so a file that later
// breaks still fails closed for the rooms it routed instead of letting them
// fall back to the frozen local copy.
const knownFile = () => join(stateDir(), 'backend.rooms.json')

export function readRouting(): Routing | undefined {
  const file = routingFile()
  if (!existsSync(file)) return undefined
  let r: Routing
  try {
    r = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
  if (typeof r?.module !== 'string' || !Array.isArray(r.rooms) || r.rooms.some(x => typeof x !== 'string'))
    throw new Error(`${file}: needs "module" (string) and "rooms" (list of room names)`)
  return { ...r, module: isAbsolute(r.module) || /^[a-z]+:/i.test(r.module) ? r.module : resolve(dirname(file), r.module) }
}

export type RoutedBackend = Backend & { remote: Backend; rooms: Set<string> }

const plain = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function routed(local: Backend, remote: Backend, rooms: string[]): RoutedBackend {
  const set = new Set(rooms)
  // The most specific root first: STATE/rooms sits inside ROOMS_HOME by default.
  const roots = () => [resolve(join(stateDir(), 'rooms')), resolve(roomsHome())]
  // The room a key belongs to ('' for the roots themselves), or undefined if not under one.
  const roomOf = (path: string): string | undefined => {
    const p = resolve(path)
    for (const root of roots()) {
      const rel = relative(root, p)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
      return rel.split(/[\\/]/)[0]
    }
    return undefined
  }
  const room = (path: string) => {
    const r = roomOf(path)
    return r !== undefined && set.has(r) ? r : undefined
  }
  // A routed room's failure says which room and why, and touches nothing else.
  const via = <T>(r: string, f: () => T): T => {
    try {
      return f()
    } catch (e) {
      throw new Error(`room ${r} is on the hub backend and it failed: ${plain(e)}`)
    }
  }
  const guarded = <T>(path: string, f: (b: Backend) => T): T => {
    const r = room(path)
    return r === undefined ? f(local) : via(r, () => f(remote))
  }
  return {
    remote,
    rooms: set,
    read: p => guarded(p, b => b.read(p)),
    write: (p, t) => guarded(p, b => b.write(p, t)),
    append: (p, t) => guarded(p, b => b.append(p, t)),
    exists: p => guarded(p, b => b.exists(p)),
    remove: p => guarded(p, b => b.remove(p)),
    claim: p => guarded(p, b => b.claim(p)),
    list(dir) {
      if (!roots().some(r => r === resolve(dir))) return guarded(dir, b => b.list(dir))
      const mine = local.list(dir).filter(e => !set.has(e.name))
      let theirs: { name: string; dir: boolean }[] = []
      try {
        theirs = remote.list(dir).filter(e => set.has(e.name))
      } catch (e) {
        // The hub being down must not take the local rooms with it.
        process.stderr.write(`rooms: hub rooms not listed: ${plain(e)}\n`)
      }
      return [...mine, ...theirs]
    },
  }
}

// What stands in for the module when it cannot be loaded: every key of a routed
// room throws a plain message, so those rooms fail and nothing is written to
// the wrong place.
function broken(why: string): Backend {
  const no = (): never => {
    throw new Error(why)
  }
  return { read: no, write: no, append: no, exists: no, list: no, remove: no, claim: no }
}

// Receipts are one host-wide file; a routed room's receipt also goes to the
// module, which acknowledges the ids it knows. The module failing never loses
// the local receipt.
export function sendReceiptToHub(room: string, file: string, text: string): void {
  if (!('remote' in current) || !(current as RoutedBackend).rooms.has(room.split('/')[0])) return
  try {
    ;(current as RoutedBackend).remote.write(file, text)
  } catch (e) {
    process.stderr.write(`rooms: delivery receipt not sent to the hub: ${plain(e)}\n`)
  }
}

// Called once at the entry point: the module is imported asynchronously, the
// callers are not. The module's default export is a Backend, or a function
// returning one. CLAUDE_ROOMS_BACKEND wins; otherwise STATE/backend.json
// routes the rooms it lists; with neither, files. A routing setup that is
// broken (bad file, module, token) fails only the rooms it lists.
export async function loadBackend(): Promise<void> {
  const spec = process.env.CLAUDE_ROOMS_BACKEND
  if (spec) {
    current = await importBackend(spec, 'CLAUDE_ROOMS_BACKEND')
    return
  }
  let rooms: string[] = []
  try {
    const routing = readRouting()
    if (!routing) return
    rooms = routing.rooms
    try {
      writeFileSync(knownFile(), JSON.stringify(rooms))
    } catch {}
    if (rooms.length === 0) return
    const settings = routing.settings && typeof routing.settings === 'object' ? routing.settings : {}
    const timeoutMs = HUB_TIMEOUT_MS
    current = routed(localBackend, await importBackend(routing.module, routingFile(), { timeoutMs, ...settings }), rooms)
  } catch (e) {
    if (!rooms.length) {
      try {
        rooms = JSON.parse(readFileSync(knownFile(), 'utf8'))
      } catch {}
    }
    process.stderr.write(`rooms: routing is broken, rooms on the hub are unavailable: ${plain(e)}\n`)
    current = routed(localBackend, broken(`the hub backend could not be set up: ${plain(e)}`), rooms)
  }
}

// Bound on one hub call, passed to the module as settings.timeoutMs, and on a
// whole plugin hook (see watchdog); both below the plugin's own 20 s.
export const HUB_TIMEOUT_MS = 8000

// Whether a room's records live behind a module rather than in files on this
// machine, so a record's path is a key and not something an editor can open.
export function isRouted(room: string): boolean {
  if (current === localBackend) return false
  return !('remote' in current) || (current as RoutedBackend).rooms.has(room)
}

export function useBackend(b: Backend): void {
  current = b
}
