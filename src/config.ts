import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Where things live. Room records are a git repo of their own (ROOMS_HOME),
// separate from this code, so the plugin can be shared without anyone's rooms.
// Runtime state (inboxes, leases, receipts) is per machine and never committed.

export function roomsHome(): string {
  return process.env.CLAUDE_ROOMS_HOME || join(homedir(), 'rooms')
}

// Inside the rooms home (and kept out of its git), so a sandboxed session
// needs only one writable path.
export function stateDir(): string {
  return process.env.CLAUDE_ROOMS_STATE || join(roomsHome(), '.state')
}

// A worker's scratch folder. Under the state dir, so the one sandbox entry
// for the rooms home covers it and git never sees it.
export function scratchDir(room: string, id: string): string {
  return join(stateDir(), 'scratch', room, id)
}

// Where state lived before 0.3; `rooms init` moves it.
export const legacyStateDir = () => join(homedir(), '.local', 'state', 'claude-rooms')

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function claudeBin(): string {
  return process.env.CLAUDE_ROOMS_CLAUDE || 'claude'
}

// A lease younger than this means the lead session's plugin drains the inbox.
export const LEASE_FRESH_MS = 45_000

export type Tier = { model?: string; effort?: string }
export type Config = {
  tiers: { [name: string]: Tier }
  worker: { permissionMode: string; tier: string }
  lead: { permissionMode: string; model?: string; allowedTools: string[] }
  provisionalMinutes: number // a two-way default applies this long after it is set, at least 30
  commitDebounceMs: number
  hallMonitor: { maxThreads: number; queueLimit: number } // parallel workers per room; items that may wait on one role before it is cloned
}

// Staffing tiers follow the old rubric; deep work needs the owner's ask, so it
// is not a tier here: pass --model explicitly when the owner asked for it.
const DEFAULTS: Config = {
  tiers: {
    light: { model: 'claude-haiku-5-5', effort: 'medium' },
    standard: { model: 'claude-sonnet-5-5', effort: 'medium' },
    review: { model: 'claude-opus-5-5', effort: 'high' },
  },
  worker: { permissionMode: 'auto', tier: 'standard' },
  lead: { permissionMode: 'auto', allowedTools: ['Bash(rooms *)', 'Read', 'Edit', 'Write'] },
  provisionalMinutes: 60,
  commitDebounceMs: 60_000,
  hallMonitor: { maxThreads: 4, queueLimit: 1 },
}

let cached: Config | undefined

export function config(): Config {
  if (cached) return cached
  const file = process.env.CLAUDE_ROOMS_CONFIG || join(homedir(), '.config', 'claude-rooms', 'config.json')
  let user: Partial<Config> = {}
  if (existsSync(file)) user = JSON.parse(readFileSync(file, 'utf8'))
  cached = {
    ...DEFAULTS,
    ...user,
    tiers: { ...DEFAULTS.tiers, ...user.tiers },
    worker: { ...DEFAULTS.worker, ...user.worker },
    lead: { ...DEFAULTS.lead, ...user.lead },
    hallMonitor: { ...DEFAULTS.hallMonitor, ...user.hallMonitor },
  }
  return cached
}
