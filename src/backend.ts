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

export function routed(local: Backend, remote: Backend, rooms: string[]): Backend {
  const set = new Set(rooms)
  const roots = () => [resolve(roomsHome()), resolve(join(stateDir(), 'rooms'))]
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
  const pick = (path: string) => {
    const room = roomOf(path)
    return room !== undefined && set.has(room) ? remote : local
  }
  return {
    read: p => pick(p).read(p),
    write: (p, t) => pick(p).write(p, t),
    append: (p, t) => pick(p).append(p, t),
    exists: p => pick(p).exists(p),
    remove: p => pick(p).remove(p),
    claim: p => pick(p).claim(p),
    list(dir) {
      if (!roots().includes(resolve(dir))) return pick(dir).list(dir)
      const mine = local.list(dir).filter(e => !set.has(e.name))
      const theirs = remote.list(dir).filter(e => set.has(e.name))
      return [...mine, ...theirs]
    },
  }
}

// Called once at the entry point: the module is imported asynchronously, the
// callers are not. The module's default export is a Backend, or a function
// returning one. CLAUDE_ROOMS_BACKEND wins; otherwise STATE/backend.json
// routes the rooms it lists; with neither, files.
export async function loadBackend(): Promise<void> {
  const spec = process.env.CLAUDE_ROOMS_BACKEND
  if (spec) {
    current = await importBackend(spec, 'CLAUDE_ROOMS_BACKEND')
    return
  }
  const routing = readRouting()
  if (!routing || routing.rooms.length === 0) return
  current = routed(localBackend, await importBackend(routing.module, routingFile(), routing.settings), routing.rooms)
}

export function useBackend(b: Backend): void {
  current = b
}
