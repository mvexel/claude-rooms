import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { backend, isRouted } from './backend.ts'
import { scratchDir, stateDir } from './config.ts'
import { Record } from './record.ts'
import type { Room } from './room.ts'

// In a room whose records live on the hub, an item's path is a key, not a file
// a worker can edit. The worker gets a working copy in its scratch folder
// instead. Commands that touch the item (log, set, need, done, spawn) first
// take in what the worker changed there, then write the item and refresh the
// copy. Only sections the worker changed since the last sync are taken in
// (Log is left to the commands); fields stay with the commands.
// Local rooms: the item file is the path, nothing here applies.

export function workingPath(room: string, rec: Record): string {
  return isRouted(room) ? join(scratchDir(room, rec.get('id')), basename(rec.path)) : rec.path
}

const baseOf = (file: string) => join(join(file, '..'), `.${basename(file)}.base`)

// What this process itself took in from each file (syncIn, pullWorking): a file that still holds exactly
// that text may be refreshed; one that holds anything else was edited by someone else meanwhile.
const taken = new Map<string, string>()

const readOr = (f: string): string | undefined => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return undefined
  }
}

// Refresh `file` (and its base) with the hub's text, unless it holds an edit
// nobody has taken in yet: then both stay for the next syncIn to merge.
// Nothing is written when the bytes already match.
function refresh(file: string, base: string, text: string): void {
  const cur = readOr(file)
  const was = readOr(base)
  if (cur !== undefined && was !== undefined && cur !== was && cur !== taken.get(file)) return
  if (cur !== text) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  if (was !== text) writeFileSync(base, text)
  taken.delete(file)
}

// Make (or refresh) the working copy; returns its path. For a local room: the item itself.
export function publishWorking(r: Room, rec: Record): string {
  const file = workingPath(r.name, rec)
  if (file === rec.path) return file
  refresh(file, baseOf(file), rec.toString())
  return file
}

// Take the worker's edits from the working copy into rec (not saved).
export function pullWorking(r: Room, rec: Record): void {
  const file = workingPath(r.name, rec)
  if (file === rec.path || !existsSync(file) || !existsSync(baseOf(file))) return
  const text = readFileSync(file, 'utf8')
  const baseText = readFileSync(baseOf(file), 'utf8')
  if (text === baseText) return
  taken.set(file, text)
  const mine = new Record(file, text)
  const base = new Record(file, baseText)
  for (const [name] of mine.sections) {
    if (name === 'Log') continue
    if (mine.section(name) !== base.section(name)) rec.setSection(name, mine.section(name))
  }
}

// Find an item and take in its working copy, if it has one.
export function findWorkItem(r: Room, id: string): Record {
  const rec = r.find(id)
  if (id.startsWith('T')) pullWorking(r, rec)
  return rec
}

// ---- the rest of a routed room's records ------------------------------------
// BRIEF.md, now-head.md, PRD.md, notes/, decisions/ and refinements/ get a
// working tree under STATE/work/<room>. The lead and workers edit files there.
// Every `rooms <cmd> <room>` first takes in what changed in the tree (syncIn),
// and refreshes the tree from the hub when it ends (syncOut). Edits made on
// the hub meanwhile are kept: records merge field by field and section by
// section; where both sides changed the same one, the hub wins and the edited
// file is kept beside it as <file>.conflict. Items keep T48's per-item copy.
// Local rooms: none of this applies.

const TOP = ['BRIEF.md', 'now-head.md', 'PRD.md']
const DIRS = ['notes', 'decisions', 'refinements']
const warn = (m: string) => process.stderr.write(`rooms: ${m}\n`)

export const treeDir = (room: string) => join(stateDir(), 'work', room)
const treeBase = (file: string) => join(dirname(file), `.${basename(file)}.base`)

// Where an editor opens a record: the working tree (or item copy) in a routed room, the file itself otherwise.
export function editPath(r: Room, path: string): string {
  if (!isRouted(r.name)) return path
  const rel = relative(r.dir, path)
  return join(treeDir(r.name), rel)
}

// The room's folder as an editor sees it.
export const editDir = (r: Room) => (isRouted(r.name) ? treeDir(r.name) : r.dir)

// Files of the hub room that belong in the tree, as paths relative to the room.
function hubFiles(r: Room): string[] {
  const out = TOP.filter(f => backend().exists(join(r.dir, f)))
  const walk = (rel: string) => {
    for (const e of backend().list(join(r.dir, rel))) {
      if (e.name.startsWith('.')) continue
      if (e.dir) walk(join(rel, e.name))
      else out.push(join(rel, e.name))
    }
  }
  for (const d of DIRS) walk(d)
  return out
}

function treeFiles(room: string): string[] {
  const root = treeDir(room)
  const out: string[] = []
  const walk = (rel: string) => {
    let es: import('node:fs').Dirent[]
    try {
      es = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.name.startsWith('.') || e.name.endsWith('.conflict')) continue
      if (e.isDirectory()) walk(join(rel, e.name))
      else out.push(join(rel, e.name))
    }
  }
  walk('')
  return out.filter(f => TOP.includes(f) || DIRS.includes(f.split('/')[0]))
}

// Three-way merge of one record: `hub` is the current text, `base` what the tree last got, `mine` the edit.
function mergeRecord(hub: string, base: string, mine: string): { text: string; clash: string[] } {
  const H = new Record('', hub)
  const B = new Record('', base)
  const M = new Record('', mine)
  const clash: string[] = []
  const take = (what: string, m: string, b: string, h: string, set: () => void) => {
    if (m === b || h === m) return
    if (h === b) set()
    else clash.push(what)
  }
  for (const [k] of M.fields) take(k, M.get(k), B.get(k), H.get(k), () => H.set(k, M.get(k)))
  for (const [n] of M.sections) take(`## ${n}`, M.section(n), B.section(n), H.section(n), () => H.setSection(n, M.section(n)))
  take('text above the first section', M.preamble, B.preamble, H.preamble, () => (H.preamble = M.preamble))
  return { text: H.toString(), clash }
}

// Take edits made in the working tree (and in item copies) to the hub.
// Returns the warnings it printed (conflicts), so a hook can hand them to the lead.
export function syncIn(r: Room): string[] {
  const notes: string[] = []
  const warn = (m: string) => {
    notes.push(m)
    process.stderr.write(`rooms: ${m}\n`)
  }
  const root = treeDir(r.name)
  for (const rel of treeFiles(r.name)) {
    const file = join(root, rel)
    const mine = readFileSync(file, 'utf8')
    const baseFile = treeBase(file)
    const key = join(r.dir, rel)
    if (!existsSync(baseFile)) {
      // A file made here: only notes are new by hand; the hub's copy, if any, is not replaced.
      if (rel.startsWith('notes/') && !backend().exists(key)) {
        backend().write(key, mine)
        refresh(file, baseFile, mine)
      }
      continue
    }
    const base = readFileSync(baseFile, 'utf8')
    if (mine === base) continue
    taken.set(file, mine)
    const hub = backend().read(key)
    if (hub === undefined || hub === base) {
      backend().write(key, mine)
      refresh(file, baseFile, mine) // what was written (or queued) is now the base
      continue
    }
    if (hub === mine) {
      refresh(file, baseFile, mine)
      continue
    }
    if (/^---\n/.test(mine) && rel.endsWith('.md') && !rel.startsWith('notes/')) {
      const m = mergeRecord(hub, base, mine)
      if (m.text !== hub) backend().write(key, m.text)
      if (!m.clash.length) refresh(file, baseFile, m.text)
      else {
        writeFileSync(`${file}.conflict`, mine)
        warn(`${rel} changed on the hub too (${m.clash.join(', ')}); the hub's version stays, yours is in ${file}.conflict`)
        refresh(file, baseFile, m.text) // reported once: the file follows the hub, so the next poll finds no clash
      }
    } else {
      writeFileSync(`${file}.conflict`, mine)
      warn(`${rel} changed on the hub too; the hub's version stays, yours is in ${file}.conflict`)
      refresh(file, baseFile, hub)
    }
  }
  // Item copies of this room (workers' and the lead's).
  for (const id of itemCopies(r)) {
    if (!copyEdited(r, id)) continue
    let rec: Record
    try {
      rec = r.find(id)
    } catch {
      continue
    }
    const before = rec.toString()
    pullWorking(r, rec)
    if (rec.toString() !== before) rec.save()
    publishWorking(r, rec) // the copy's base follows what was saved
  }
  return notes
}

// Item copies of the room that hold edits not yet taken in; unchanged ones cost nothing.
function itemCopies(r: Room): string[] {
  const items = join(stateDir(), 'scratch', r.name)
  let ids: string[] = []
  try {
    ids = readdirSync(items).filter(d => /^T\d+$/.test(d))
  } catch {}
  return ids
}

// A copy whose bytes equal its base has no edit to take in.
function copyEdited(r: Room, id: string): boolean {
  const dir = scratchDir(r.name, id)
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.'))
  } catch {}
  return names.some(n => {
    const file = join(dir, n)
    const base = readOr(baseOf(file))
    return base !== undefined && readOr(file) !== base
  })
}

// Refresh the working tree and item copies from the hub.
export function syncOut(r: Room): void {
  const root = treeDir(r.name)
  for (const rel of hubFiles(r)) {
    const text = backend().read(join(r.dir, rel))
    if (text === undefined) continue
    const file = join(root, rel)
    refresh(file, treeBase(file), text)
  }
  // Item copies: read the hub's text for the file and refresh only when it differs from the copy's base
  // (no record lookup, nothing written for a copy whose hub record is unchanged).
  for (const id of itemCopies(r)) {
    const dir = scratchDir(r.name, id)
    let names: string[] = []
    try {
      names = readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.'))
    } catch {}
    for (const n of names) {
      const file = join(dir, n)
      const text = backend().read(join(r.dir, 'items', n))
      if (text === undefined || text === readOr(baseOf(file))) continue
      refresh(file, baseOf(file), text)
    }
  }
}
