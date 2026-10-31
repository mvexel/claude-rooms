import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// Called once at the entry point: the module is imported asynchronously, the
// callers are not. The module's default export is a Backend, or a function
// returning one.
export async function loadBackend(): Promise<void> {
  const spec = process.env.CLAUDE_ROOMS_BACKEND
  if (!spec) return
  const url = /^[a-z]+:/i.test(spec) && !isAbsolute(spec) ? spec : pathToFileURL(resolve(spec)).href
  const mod = await import(url)
  const b = typeof mod.default === 'function' ? await mod.default() : mod.default
  for (const m of ['read', 'write', 'append', 'exists', 'list', 'remove', 'claim'])
    if (typeof b?.[m] !== 'function') throw new Error(`CLAUDE_ROOMS_BACKEND ${spec}: default export has no ${m}()`)
  current = b
}

export function useBackend(b: Backend): void {
  current = b
}
