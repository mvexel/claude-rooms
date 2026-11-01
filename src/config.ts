import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

export function codexBin(): string {
  return process.env.CLAUDE_ROOMS_CODEX || 'codex'
}

// A lease younger than this means the lead session's plugin drains the inbox.
export const LEASE_FRESH_MS = 45_000

export type Tier = { model?: string; effort?: string }
export type Config = {
  tiers: { [name: string]: Tier }
  worker: { permissionMode: string; tier: string }
  lead: { permissionMode: string; model?: string; allowedTools: string[] }
  // Codex workers: their own model and effort (Codex ids, never Claude tiers)
  // and sandbox. Unset model/effort mean Codex's own configured default.
  // File-only: the sandbox is a privilege, so the page cannot change it.
  codex: { model?: string; effort?: string; sandbox: string; addDirs: string[] }
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
  codex: { sandbox: 'workspace-write', addDirs: [] },
  provisionalMinutes: 60,
  commitDebounceMs: 60_000,
  hallMonitor: { maxThreads: 4, queueLimit: 1 },
}

// Page edits go to a separate overrides file, loaded after config.json, so a
// hand-edited config.json is never rewritten. Only the keys in EDITABLE can be
// overridden; the lead's permissionMode and allowedTools stay file-only.
export function configFile(): string {
  return process.env.CLAUDE_ROOMS_CONFIG || join(homedir(), '.config', 'claude-rooms', 'config.json')
}
export function overridesFile(): string {
  return process.env.CLAUDE_ROOMS_OVERRIDES || join(dirname(configFile()), 'overrides.json')
}

export type Overrides = {
  tiers?: { [name: string]: Tier }
  worker?: { tier?: string }
  lead?: { model?: string }
  provisionalMinutes?: number
  commitDebounceMs?: number
  hallMonitor?: { maxThreads?: number; queueLimit?: number }
}

const isObj = (v: unknown): v is { [k: string]: unknown } => !!v && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v: unknown, what: string, flagSafe = false): string => {
  if (typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v) || v.length > 200) throw new Error(`${what} must be a non-empty single-line string`)
  // These become command-line values; a leading '-' would read as a flag.
  if (flagSafe && v.trim().startsWith('-')) throw new Error(`${what} must not start with '-'`)
  return v.trim()
}
const num = (v: unknown, what: string, min: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > 10_000_000) throw new Error(`${what} must be a whole number of at least ${min}`)
  return v
}

// A patch is a partial Overrides; null clears a key. Returns the cleaned patch
// or throws with what is wrong. Unknown keys are refused, not dropped.
export function validatePatch(patch: unknown): { [k: string]: any } {
  if (!isObj(patch)) throw new Error('body must be a JSON object')
  const out: { [k: string]: any } = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'provisionalMinutes') out[k] = v === null ? null : num(v, k, 30)
    else if (k === 'commitDebounceMs') out[k] = v === null ? null : num(v, k, 0)
    else if (k === 'tiers') {
      if (v === null) { out.tiers = null; continue }
      if (!isObj(v)) throw new Error('tiers must be an object')
      out.tiers = {}
      for (const [name, t] of Object.entries(v)) {
        if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) throw new Error(`tier name '${name}' is not valid`)
        if (t === null) { out.tiers[name] = null; continue }
        if (!isObj(t)) throw new Error(`tiers.${name} must be an object`)
        out.tiers[name] = {}
        for (const [f, x] of Object.entries(t)) {
          if (f !== 'model' && f !== 'effort') throw new Error(`tiers.${name}.${f} cannot be set here`)
          out.tiers[name][f] = x === null ? null : nonEmpty(x, `tiers.${name}.${f}`, true)
        }
      }
    } else if (k === 'worker') {
      if (v === null) { out.worker = null; continue }
      if (!isObj(v)) throw new Error('worker must be an object')
      out.worker = {}
      for (const [f, x] of Object.entries(v)) {
        if (f === 'permissionMode') throw new Error('worker.permissionMode is read-only here; edit config.json by hand')
        if (f !== 'tier') throw new Error(`worker.${f} cannot be set here`)
        out.worker[f] = x === null ? null : nonEmpty(x, 'worker.tier')
      }
    } else if (k === 'hallMonitor') {
      if (v === null) { out.hallMonitor = null; continue }
      if (!isObj(v)) throw new Error('hallMonitor must be an object')
      out.hallMonitor = {}
      for (const [f, x] of Object.entries(v)) {
        if (f !== 'maxThreads' && f !== 'queueLimit') throw new Error(`hallMonitor.${f} cannot be set here`)
        out.hallMonitor[f] = x === null ? null : num(x, `hallMonitor.${f}`, f === 'maxThreads' ? 1 : 0)
      }
    } else if (k === 'lead') {
      if (v === null) { out.lead = null; continue }
      if (!isObj(v)) throw new Error('lead must be an object')
      out.lead = {}
      for (const [f, x] of Object.entries(v)) {
        if (f !== 'model') throw new Error(`lead.${f} is read-only here; edit config.json by hand`)
        out.lead[f] = x === null ? null : nonEmpty(x, 'lead.model', true)
      }
    } else throw new Error(`'${k}' cannot be set here`)
  }
  return out
}

// Merge a patch into the saved overrides (null deletes), dropping empties.
export function mergePatch(base: Overrides, patch: { [k: string]: any }): Overrides {
  const out: any = JSON.parse(JSON.stringify(base))
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else if (isObj(v) && k === 'tiers') {
      out.tiers ??= {}
      for (const [name, t] of Object.entries(v)) {
        if (t === null) delete out.tiers[name]
        else {
          out.tiers[name] = { ...out.tiers[name] }
          for (const [f, x] of Object.entries(t as object)) x === null ? delete out.tiers[name][f] : (out.tiers[name][f] = x)
          if (!Object.keys(out.tiers[name]).length) delete out.tiers[name]
        }
      }
    } else if (isObj(v)) {
      out[k] = { ...out[k] }
      for (const [f, x] of Object.entries(v)) x === null ? delete out[k][f] : (out[k][f] = x)
    } else out[k] = v
    if (isObj(out[k]) && !Object.keys(out[k]).length) delete out[k]
  }
  return out
}

// Cross-field check on the merged result: the worker default tier must exist.
export function checkEffective(o: Overrides, user: Partial<Config>): void {
  const m = merge(user, o)
  if (!m.tiers[m.worker.tier]) throw new Error(`worker.tier '${m.worker.tier}' is not a defined tier`)
}

export function saveOverrides(o: Overrides): void {
  const file = overridesFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n')
  renameSync(tmp, file)
}

function readJsonFile(file: string): any {
  if (!existsSync(file)) return {}
  const v = JSON.parse(readFileSync(file, 'utf8'))
  return isObj(v) ? v : {}
}

// Keep only what the page may override, so a hand-edited overrides file cannot
// widen privileges either. Privilege keys are dropped and reported; any other
// invalid value voids the whole file (reported), never half applied.
function sane(raw: any): { o: Overrides; error?: string } {
  const dropped: string[] = []
  if (isObj(raw)) {
    raw = { ...raw }
    for (const [sec, key] of [['lead', 'permissionMode'], ['lead', 'allowedTools'], ['worker', 'permissionMode']]) {
      if (isObj(raw[sec]) && key in raw[sec]) { raw[sec] = { ...raw[sec] }; delete raw[sec][key]; dropped.push(`${sec}.${key}`) }
    }
  }
  const note = dropped.length ? `ignored ${dropped.join(', ')} (edit config.json by hand)` : undefined
  try {
    const p = validatePatch(raw)
    const o: Overrides = {}
    for (const k of Object.keys(p)) if (p[k] !== null) (o as any)[k] = p[k]
    return { o, error: note }
  } catch (e) {
    return { o: {}, error: `overrides file ignored: ${(e as Error).message}` }
  }
}

function merge(user: Partial<Config>, over: Overrides): Config {
  const u = user as any
  const tiers: Config['tiers'] = { ...DEFAULTS.tiers, ...u.tiers }
  for (const [n, t] of Object.entries(over.tiers ?? {})) tiers[n] = { ...tiers[n], ...t }
  return {
    ...DEFAULTS,
    ...user,
    ...(over.provisionalMinutes !== undefined ? { provisionalMinutes: over.provisionalMinutes } : {}),
    ...(over.commitDebounceMs !== undefined ? { commitDebounceMs: over.commitDebounceMs } : {}),
    tiers,
    hallMonitor: { ...DEFAULTS.hallMonitor, ...user.hallMonitor, ...over.hallMonitor },
    worker: { ...DEFAULTS.worker, ...user.worker, ...over.worker },
    lead: { ...DEFAULTS.lead, ...user.lead, ...over.lead },
    codex: { ...DEFAULTS.codex, ...user.codex },
  }
}

const stamp = (f: string) => {
  try { return statSync(f).mtimeMs + ':' + statSync(f).size } catch { return '-' }
}

export type Layers = { defaults: Config; file: Partial<Config>; overrides: Overrides; overridesError?: string; fileError?: string; effective: Config }
let cached: { key: string; layers: Layers } | undefined

// Re-read when either file changes, so page edits and hand edits apply without
// a server restart; each spawn calls config() afresh.
export function configLayers(): Layers {
  const key = stamp(configFile()) + '|' + stamp(overridesFile())
  if (cached?.key === key) return cached.layers
  const file: Partial<Config> = readJsonFile(configFile())
  // A hand-edited hallMonitor value out of range is dropped, with the reason shown.
  let fileError: string | undefined
  const hm: any = (file as any).hallMonitor
  if (isObj(hm)) {
    const bad: string[] = []
    for (const [f, min] of [['maxThreads', 1], ['queueLimit', 0]] as const) {
      if (f in hm && (typeof hm[f] !== 'number' || !Number.isInteger(hm[f]) || hm[f] < min)) { delete hm[f]; bad.push(`hallMonitor.${f} must be a whole number of at least ${min}`) }
    }
    if (bad.length) fileError = `config.json: ${bad.join('; ')} (default used)`
  }
  let overrides: Overrides = {}
  let overridesError: string | undefined
  try {
    const r = sane(readJsonFile(overridesFile()))
    overrides = r.o
    overridesError = r.error
  } catch (e) { overridesError = `overrides file unreadable: ${(e as Error).message}` }
  const layers = { defaults: DEFAULTS, file, overrides, overridesError, fileError, effective: merge(file, overrides) }
  cached = { key, layers }
  return layers
}

export function config(): Config {
  return configLayers().effective
}
