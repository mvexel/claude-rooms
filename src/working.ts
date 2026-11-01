import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isRouted } from './backend.ts'
import { scratchDir } from './config.ts'
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

// Make (or refresh) the working copy; returns its path. For a local room: the item itself.
export function publishWorking(r: Room, rec: Record): string {
  const file = workingPath(r.name, rec)
  if (file === rec.path) return file
  mkdirSync(join(file, '..'), { recursive: true })
  const text = rec.toString()
  writeFileSync(file, text)
  writeFileSync(baseOf(file), text)
  return file
}

// Take the worker's edits from the working copy into rec (not saved).
export function pullWorking(r: Room, rec: Record): void {
  const file = workingPath(r.name, rec)
  if (file === rec.path || !existsSync(file) || !existsSync(baseOf(file))) return
  const mine = new Record(file, readFileSync(file, 'utf8'))
  const base = new Record(file, readFileSync(baseOf(file), 'utf8'))
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
