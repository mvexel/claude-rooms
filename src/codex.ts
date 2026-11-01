import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexBin, config, roomsHome, stateDir } from './config.ts'
import { emit } from './events.ts'
import { Room } from './room.ts'
import { type Liveness, pidLiveness } from './sessions.ts'

// Codex workers: `codex exec --json` run by a detached runner (`rooms run-codex`)
// in the item's worktree. Machine-local run state lives in
// STATE/runs/<room>/<Tnn>.{json,lock,jsonl,prompt}: it describes a process on
// this machine, like turn.json. The item itself keeps `backend: codex` and
// `agent: codex:<runId>`, plus `codex_session` once Codex reports its thread.
//
// A finished Codex turn is not a finished item: the runner tells the lead when
// the turn ended with the item still doing, when the run failed, and (sweep)
// when the runner vanished.

export type RunState = 'starting' | 'running' | 'idle' | 'failed'
export type RunSpec = { cwd: string; who: string; scratch: string; model?: string; effort?: string; sandbox: string; addDirs: string[]; network?: boolean }
export type Run = {
  runId: string
  state: RunState
  startedAt: string
  pid?: number // the runner
  codexPid?: number // codex itself; its own process group, so it outlives a killed runner
  threadId?: string
  exitCode?: number | null
  error?: string
  lastEvent?: string
  notified?: boolean
  resume?: boolean // started by rooms tell: drain the queue into the existing thread
  prev?: RunState // state to restore when a resume runner finds nothing queued
  spec: RunSpec
}

const START_GRACE_MS = 30_000
const EMPTY_LOCK_STALE_MS = 5_000
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runBase = (room: string, id: string) => join(stateDir(), 'runs', room, id)
const runFile = (room: string, id: string) => `${runBase(room, id)}.json`
const lockFile = (room: string, id: string) => `${runBase(room, id)}.lock`

export const isCodex = (it: { get(k: string): string }): boolean => it.get('backend') === 'codex'

export function readRun(room: string, id: string): Run | undefined {
  try {
    return JSON.parse(readFileSync(runFile(room, id), 'utf8'))
  } catch {
    return undefined
  }
}

function writeRun(room: string, id: string, run: Run): void {
  mkdirSync(dirname(runFile(room, id)), { recursive: true })
  writeFileSync(`${runFile(room, id)}.${process.pid}.tmp`, JSON.stringify(run, null, 2))
  renameSync(`${runFile(room, id)}.${process.pid}.tmp`, runFile(room, id))
}

function lockHolder(room: string, id: string): number | undefined {
  try {
    return Number(readFileSync(lockFile(room, id), 'utf8').trim()) || undefined
  } catch {
    return undefined
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Is this item's Codex run going? 'unknown' only when there is no run record
// for an item that claims a worker (a lost state dir): never a reason to spawn.
export function codexLiveness(room: string, id: string): { live: Liveness; state: RunState | 'none'; run?: Run } {
  const run = readRun(room, id)
  if (!run) return { live: 'unknown', state: 'none' }
  if (run.state === 'idle' || run.state === 'failed') return { live: 'dead', state: run.state, run }
  const pid = lockHolder(room, id) ?? run.pid
  if (pid) {
    const l = pidLiveness(pid)
    if (l !== 'dead') return { live: l, state: run.state, run }
  }
  // A killed runner does not stop codex (own process group): still a live worker.
  if (run.codexPid && groupAlive(run.codexPid)) return { live: 'alive', state: run.state, run }
  // No runner yet: it was just started and has not taken its lock.
  if (Date.now() - Date.parse(run.startedAt) < START_GRACE_MS && !run.pid) return { live: 'alive', state: 'starting', run }
  return { live: 'dead', state: run.state, run }
}

// What the lead and the page show for a Codex item.
export function codexStatusWord(room: string, id: string): string {
  const { live, state, run } = codexLiveness(room, id)
  if (live === 'unknown') return 'unknown'
  if (live === 'alive') return 'working'
  return state === 'idle' ? 'idle' : run?.state === 'failed' ? 'failed' : 'exited unexpectedly'
}

export function codexArgs(spec: RunSpec, prompt: string): string[] {
  const args = ['exec', '--json', '-s', spec.sandbox, '-c', 'approval_policy="never"']
  if (spec.model) args.push('-m', spec.model)
  if (spec.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`)
  if (spec.network) args.push('-c', 'sandbox_workspace_write.network_access=true')
  args.push('-C', spec.cwd)
  for (const d of spec.addDirs) args.push('--add-dir', d)
  args.push('--', prompt)
  return args
}

// `codex exec resume` takes no -s, -C or --add-dir: the sandbox and the writable
// roots go in as config overrides (the same roots the first run had), the
// worktree as the process cwd. Always by thread id, never --last.
export function resumeArgs(spec: RunSpec, threadId: string, prompt: string): string[] {
  const args = ['exec', 'resume', '--json', '-c', `sandbox_mode=${JSON.stringify(spec.sandbox)}`, '-c', 'approval_policy="never"']
  if (spec.model) args.push('-m', spec.model)
  if (spec.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`)
  if (spec.network) args.push('-c', 'sandbox_workspace_write.network_access=true')
  args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(spec.addDirs)}`)
  args.push(threadId, '--', prompt)
  return args
}

function gitDir(cwd: string, what: string): string | undefined {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', what], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

// A worktree commit writes the repo's common dir and the worktree's own git
// dir (<repo>/.git/worktrees/<wt>); the rooms CLI commits ROOMS_HOME/.git.
// A routed room's records are on the hub, so the sandbox needs network.
export function specFor(cwd: string, who: string, scratch: string, routed = false): RunSpec {
  const c = config().codex
  const repo = existsSync(cwd) ? [gitDir(cwd, '--git-common-dir'), gitDir(cwd, '--absolute-git-dir')] : []
  const roomsGit = join(roomsHome(), '.git')
  const addDirs = [...new Set([scratch, roomsHome(), stateDir(), ...repo, ...(existsSync(roomsGit) ? [roomsGit] : []), ...c.addDirs].filter((d): d is string => !!d).map(d => resolve(d)))]
  return { cwd, who, scratch, model: c.model, effort: c.effort, sandbox: c.sandbox, addDirs, network: routed || c.network === true }
}

// The worker instructions Codex gets inline (it has no Claude plugin to load).
export function codexInstructions(room: string, id: string, who: string): string {
  return [
    `Working rules (rooms worker):`,
    `- Your item file is your brief: Acceptance is what done means, Inputs what to read, cap_h the time cap. Work in the worktree you start in, on its branch; keep scratch in ${'$'}TMPDIR, never /tmp.`,
    `- Commit on your branch with a "Work-Item: ${room}/${id}" trailer. Never push or merge to main/master; the lead merges.`,
    `- Log as you go: ROOMS_AS=${who} rooms log ${room} ${id} "<short line>".`,
    `- Never ask the user; you cannot reach them. A question goes through: rooms need ${room} ${id} "<question>", then stop and end your turn.`,
    `- Do not widen the item. Work nobody planned: rooms need ${room} ${id} "<what and why>", then stop.`,
    `- Finish: fill the item's ## Result (Done:, Artifacts:, Unverified:, Next:), THEN run rooms done ${room} ${id} (or --review). Ending your turn without rooms done or rooms need leaves the item open and the lead is told.`,
    `- A bug or surprise outside the item: log it with a command that reproduces it and say so in your Result.`,
  ].join('\n')
}

// Record a run (prompt and state) before anything starts; the caller saves the
// item, then calls launchCodex, so the runner never races the spawn's own save.
export function newRun(room: string, id: string, spec: RunSpec, prompt: string): Run {
  const run: Run = { runId: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, state: 'starting', startedAt: new Date().toISOString(), spec }
  mkdirSync(dirname(runFile(room, id)), { recursive: true })
  writeFileSync(`${runBase(room, id)}.prompt`, prompt)
  writeRun(room, id, run)
  return run
}

export function launchCodex(room: string, id: string): void {
  const log = openSync(`${runBase(room, id)}.log`, 'a')
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'cli', 'rooms.ts'), 'run-codex', room, id], { detached: true, stdio: ['ignore', log, log], env: { ...process.env } })
  closeSync(log)
  child.unref()
}

// ---- queued follow-ups ------------------------------------------------------
// rooms tell --item spools to STATE/runs/<room>/<Tnn>.q/ (one file per message, tmp+rename).
// The runner claims each message by rename; the lock keeps one run per item and a message is delivered by exactly one turn.

// The queue is a spool directory, one file per message. A tell writes a dotfile
// and renames it into place, so a message is either wholly there or not at all;
// the runner claims each message by renaming it into its own taking dir, so a
// write can never land in a file that was already taken.
const spoolDir = (room: string, id: string) => `${runBase(room, id)}.q`
const msgFiles = (dir: string): string[] => { try { return readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { return [] } }

type Taken = { name: string; text: string }

function enqueue(room: string, id: string, text: string): void {
  const dir = spoolDir(room, id)
  mkdirSync(dir, { recursive: true })
  const name = `${Date.now().toString().padStart(14, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify({ at: new Date().toISOString(), text }))
  renameSync(join(dir, `.${name}.tmp`), join(dir, name))
}

function takeDir(room: string, id: string): string { return `${spoolDir(room, id)}.taking.${process.pid}` }

function takeQueue(room: string, id: string): Taken[] {
  const dir = spoolDir(room, id)
  const mine = takeDir(room, id)
  const out: Taken[] = []
  for (const name of msgFiles(dir)) {
    mkdirSync(mine, { recursive: true })
    try { renameSync(join(dir, name), join(mine, name)) } catch { continue } // another runner claimed it
    try { out.push({ name, text: JSON.parse(readFileSync(join(mine, name), 'utf8')).text }) } catch {}
  }
  return out
}

// Delivered: forget the claimed messages.
function settle(room: string, id: string): void { try { rmSync(takeDir(room, id), { recursive: true, force: true }) } catch {} }

// A resume that failed before its turn started delivered nothing: the messages
// go back under their old names, so they stay ahead of anything newer.
function requeueHead(room: string, id: string, taken: Taken[]): void {
  for (const t of taken) try { renameSync(join(takeDir(room, id), t.name), join(spoolDir(room, id), t.name)) } catch {}
  settle(room, id)
}

function queued(room: string, id: string): boolean { return msgFiles(spoolDir(room, id)).length > 0 }

export function followUpPrompt(msgs: string[]): string {
  return msgs.length === 1 ? msgs[0] : msgs.map((m, i) => `Message ${i + 1}:\n${m}`).join('\n\n')
}

// Deliver a message to a Codex worker: persist it, and if no run is going,
// resume the same thread by id to take it. Returns the line for the caller.
export function codexTell(room: string, id: string, text: string): string {
  const first = codexLiveness(room, id)
  if (first.live === 'unknown') return 'held: no run record on this host (liveness unknown); not starting a run'
  if (first.live === 'dead' && !first.run?.threadId) return 'held: the Codex run has no session to resume (it never started a thread); respawn with --backend codex'
  // Append FIRST, then look: a runner re-checks the queue after it unlocks, so either it sees
  // this message or we see no lock holder and start one. Looking first could strand it.
  enqueue(room, id, text)
  const holder = lockHolder(room, id)
  const lv = codexLiveness(room, id)
  const { state, run } = lv
  if ((holder && pidLiveness(holder) !== 'dead') || lv.live !== 'dead' || !run) return 'queued: the running Codex worker gets it in its next turn'
  if (!run.threadId) return 'held: the Codex run has no session to resume (it never started a thread); respawn with --backend codex'
  // Not running: mark the run as starting so liveness and status see it, then launch a runner.
  // Two tells at once both launch; the lock lets one runner drain both messages.
  run.prev = state === 'idle' ? 'idle' : 'failed'
  run.state = 'starting'
  run.resume = true
  run.startedAt = new Date().toISOString()
  run.pid = undefined
  run.codexPid = undefined
  run.notified = false
  run.error = undefined
  writeRun(room, id, run)
  launchCodex(room, id)
  return 'the Codex worker is resumed with it (same session)'
}

// The runner: takes the lock, runs codex turns (the first prompt, then queued
// follow-ups resumed by thread id), records each outcome, tells the lead.
export async function runCodex(room: string, id: string): Promise<void> {
  if (!readRun(room, id)) throw new Error(`no run record for ${room}/${id}`)
  mkdirSync(dirname(lockFile(room, id)), { recursive: true })
  let current: number | undefined
  let terminated = false
  process.on('SIGTERM', () => { terminated = true; if (current) try { process.kill(-current, 'SIGTERM') } catch {} })
  for (;;) {
    if (!acquireLock(room, id)) { return } // another runner owns this item
    let again = false
    try {
      again = await drain(room, id, pid => { current = pid }, () => terminated)
    } finally {
      try { unlinkSync(lockFile(room, id)) } catch {}
    }
    // A message that arrived after the last queue check but before the unlock: take it now.
    const run = readRun(room, id)
    if (terminated || !(again || queued(room, id)) || !run?.threadId || run.state !== 'idle') {
      // The item is done and nothing is waiting: only now does its scratch folder go (a resumed turn needs it).
      // rooms done could not remove it from inside the sandbox.
      if (run && !queued(room, id)) try { if (new Room(room).find(id).get('state') === 'done') rmSync(run.spec.scratch, { recursive: true, force: true }) } catch {}
      return
    }
  }
}

// O_EXCL, also for taking over a dead holder's lock: of two runners finding a stale lock, one wins.
function acquireLock(room: string, id: string): boolean {
  for (let i = 0; i < 5; i++) {
    try {
      writeFileSync(lockFile(room, id), String(process.pid), { flag: 'wx' })
      return true
    } catch {
      const holder = lockHolder(room, id)
      if (holder === undefined) {
        // Vanished or being written: retry. But an empty file that stays empty (a runner died between create and write) is stale.
        let age = 0
        try { age = Date.now() - statSync(lockFile(room, id)).mtimeMs } catch { continue }
        if (age > EMPTY_LOCK_STALE_MS) { try { unlinkSync(lockFile(room, id)) } catch {} }
        continue
      }
      if (pidLiveness(holder) !== 'dead') return false
      try { unlinkSync(lockFile(room, id)) } catch {}
    }
  }
  return false
}

// Runs turns until the queue is empty. Returns true if it stopped for a reason a queued message could still use.
async function drain(room: string, id: string, setPid: (p?: number) => void, isTerminated: () => boolean): Promise<boolean> {
  let first = true
  for (;;) {
    const run = readRun(room, id)!
    const spec = run.spec
    let args: string[]
    let taken: Taken[] = []
    if (first && run.state === 'starting' && !run.resume) {
      args = codexArgs(spec, readFileSync(`${runBase(room, id)}.prompt`, 'utf8'))
    } else {
      if (!run.threadId) return false
      if (run.state === 'failed') return false
      taken = takeQueue(room, id)
      const msgs = taken.map(t => t.text)
      if (!msgs.length) {
        if (run.state === 'starting') { run.state = run.prev ?? 'idle'; run.resume = false; writeRun(room, id, run) } // another runner took it
        return false
      }
      args = resumeArgs(spec, run.threadId, followUpPrompt(msgs))
    }
    first = false
    run.state = 'running'
    run.pid = process.pid
    run.codexPid = undefined
    run.resume = false
    run.error = undefined
    run.notified = false
    writeRun(room, id, run)
    const { ok, started } = await turn(room, id, run, args, setPid, isTerminated)
    // A resume that never started its turn delivered nothing: the messages go back, first in line.
    if (!ok && !started && taken.length) requeueHead(room, id, taken)
    else settle(room, id)
    if (!ok || isTerminated()) return false
    if (!queued(room, id)) return false
  }
}

async function turn(room: string, id: string, run: Run, args: string[], setPid: (p?: number) => void, isTerminated: () => boolean): Promise<{ ok: boolean; started: boolean }> {
  const spec = run.spec
  mkdirSync(spec.scratch, { recursive: true }) // codex refuses every command when $TMPDIR is gone
  const env: NodeJS.ProcessEnv = { ...process.env, ROOMS_AS: spec.who, TMPDIR: spec.scratch }
  // Codex is not the lead and not a Claude session: nothing may make it look like one.
  for (const k of ['CLAUDE_ROOMS_SESSION', 'CLAUDE_CODE_SESSION_ID', 'ROOMS_TURN']) delete env[k]
  // The sandbox has no gpg agent or pinentry: a signing config would fail every commit. Codex runs only, via env, never the repo's config.
  const n = Number(env.GIT_CONFIG_COUNT) || 0
  env.GIT_CONFIG_COUNT = String(n + 1)
  env[`GIT_CONFIG_KEY_${n}`] = 'commit.gpgsign'
  env[`GIT_CONFIG_VALUE_${n}`] = 'false'
  let sawCompleted = false
  let started = false
  let failure = ''
  let lastError = '' // a top-level error alone is not a failure: codex may report non-fatal ones
  let stderr = ''
  let exit: number | null = null
  // Its own process group, so a killed runner leaves a worker that liveness still sees.
  const child = spawn(codexBin(), args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  setPid(child.pid)
  if (child.pid) {
    run.codexPid = child.pid
    writeRun(room, id, run)
  }
  let buf = ''
  const eventLog = `${runBase(room, id)}.jsonl`
  const onLine = (l: string) => {
    let e: any
    try { e = JSON.parse(l) } catch { return }
    run.lastEvent = e.type
    if (e.type === 'thread.started' && e.thread_id) {
      if (!run.threadId) {
        run.threadId = e.thread_id
        recordSession(room, id, e.thread_id)
      }
    } else if (e.type === 'turn.started') started = true
    else if (e.type === 'turn.completed') sawCompleted = true
    else if (e.type === 'turn.failed') failure = e.error?.message || 'turn failed'
    else if (e.type === 'error') lastError = e.message || ''
    writeRun(room, id, run)
  }
  child.stdout.on('data', d => {
    writeFileSync(eventLog, d, { flag: 'a' })
    buf += d
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    parts.forEach(onLine)
  })
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
  await new Promise<void>(res => {
    child.on('error', e => { failure ||= `could not start codex: ${e.message}`; res() })
    child.on('close', code => { exit = code; res() })
  })
  setPid(undefined)
  if (isTerminated()) failure ||= 'runner terminated'
  if (buf.trim()) onLine(buf)
  run.exitCode = exit
  const it = new Room(room).find(id)
  const ok = sawCompleted && exit === 0 && !failure
  if (ok) {
    run.state = 'idle'
    if (it.get('state') === 'doing' && !queued(room, id)) emit(room, `${id}'s Codex turn ended but the item is still doing and no rooms done or rooms need came from it. Read its Log and Result; rooms tell ${room} --item ${id} "<what is missing>" or re-plan.`)
  } else {
    run.state = 'failed'
    run.error = failure || lastError || stderr.trim().split('\n').pop() || `codex exited with ${exit}`
    emit(room, `${id}'s Codex run failed (${run.error}). The item is still ${it.get('state')}, nothing was marked done. Check ${runBase(room, id)}.jsonl, then rooms tell ${room} --item ${id} to resume the session with a message, or rooms spawn ${room} ${id} --backend codex to start again, or reassign it.`)
  }
  run.notified = true
  writeRun(room, id, run)
  return { ok, started }
}

// Write the Codex thread id onto the item (a small load-modify-save).
function recordSession(room: string, id: string, thread: string): void {
  try {
    const it = new Room(room).find(id)
    it.set('codex_session', thread)
    it.save()
  } catch {}
}

// A runner killed mid-turn leaves its claimed messages in <Tnn>.q.taking.<pid>.
// Put them back in the queue under their old names and say which dir it was.
function restoreOrphans(room: string, id: string): string {
  const base = `${spoolDir(room, id)}.taking.`
  const dir = dirname(base)
  const mine: string[] = []
  try { for (const f of readdirSync(dir)) if (join(dir, f).startsWith(base)) mine.push(join(dir, f)) } catch { return '' }
  const notes: string[] = []
  for (const d of mine) {
    const pid = Number(d.slice(base.length))
    if (pid && pidLiveness(pid) !== 'dead') continue
    let n = 0
    mkdirSync(spoolDir(room, id), { recursive: true })
    for (const name of msgFiles(d)) try { renameSync(join(d, name), join(spoolDir(room, id), name)); n++ } catch {}
    try { rmSync(d, { recursive: true, force: true }) } catch {}
    notes.push(`Orphaned ${d.slice(dir.length + 1)} held ${n} undelivered message${n === 1 ? '' : 's'}; restored to the queue.`)
  }
  return notes.join(' ')
}

// Run by sweep: a runner that vanished without recording an outcome (killed, host
// restart) is a failed run, and the lead hears it once.
export function reconcileCodex(): string[] {
  const out: string[] = []
  for (const r of Room.all()) {
    let items
    try { items = r.items() } catch { continue }
    for (const it of items) {
      if (!isCodex(it) || it.get('state') !== 'doing') continue
      const id = it.get('id')
      const { live, state, run } = codexLiveness(r.name, id)
      if (live !== 'dead' || !run || (state !== 'running' && state !== 'starting') || run.notified) continue
      run.state = 'failed'
      run.error = 'process exited unexpectedly'
      run.notified = true
      writeRun(r.name, id, run)
      try { unlinkSync(lockFile(r.name, id)) } catch {}
      const orphans = restoreOrphans(r.name, id)
      emit(r.name, `${id}'s Codex worker exited unexpectedly (no outcome recorded) with the item still doing.${orphans ? ` ${orphans}` : ''} Check ${runBase(r.name, id)}.jsonl and .log, then rooms spawn ${r.name} ${id} --backend codex, or reassign.`)
      out.push(`${r.name}: ${id} codex run exited unexpectedly`)
    }
  }
  return out
}
