import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
export type RunSpec = { cwd: string; who: string; scratch: string; model?: string; effort?: string; sandbox: string; addDirs: string[] }
export type Run = {
  runId: string
  state: RunState
  startedAt: string
  pid?: number // the runner
  threadId?: string
  exitCode?: number | null
  error?: string
  lastEvent?: string
  notified?: boolean
  spec: RunSpec
}

const START_GRACE_MS = 30_000
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
  args.push('-C', spec.cwd)
  for (const d of spec.addDirs) args.push('--add-dir', d)
  args.push('--', prompt)
  return args
}

function gitCommonDir(cwd: string): string | undefined {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

export function specFor(cwd: string, who: string, scratch: string): RunSpec {
  const c = config().codex
  const git = existsSync(cwd) ? gitCommonDir(cwd) : undefined
  const addDirs = [...new Set([scratch, roomsHome(), stateDir(), ...(git ? [git] : []), ...c.addDirs].map(d => resolve(d)))]
  return { cwd, who, scratch, model: c.model, effort: c.effort, sandbox: c.sandbox, addDirs }
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

// Start a run (a first one, or a respawn): record it, then detach a runner.
export function startCodex(room: string, id: string, spec: RunSpec, prompt: string): Run {
  const run: Run = { runId: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, state: 'starting', startedAt: new Date().toISOString(), spec }
  mkdirSync(dirname(runFile(room, id)), { recursive: true })
  writeFileSync(`${runBase(room, id)}.prompt`, prompt)
  writeRun(room, id, run)
  const log = openSync(`${runBase(room, id)}.log`, 'a')
  const env = { ...process.env }
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'cli', 'rooms.ts'), 'run-codex', room, id], { detached: true, stdio: ['ignore', log, log], env })
  closeSync(log)
  child.unref()
  return run
}

const lines = (text: string) => text.split('\n').filter(Boolean)

// The runner: takes the lock, runs codex, records the outcome, tells the lead.
export async function runCodex(room: string, id: string): Promise<void> {
  const run = readRun(room, id)
  if (!run) throw new Error(`no run record for ${room}/${id}`)
  mkdirSync(dirname(lockFile(room, id)), { recursive: true })
  try {
    writeFileSync(lockFile(room, id), String(process.pid), { flag: 'wx' })
  } catch {
    const holder = lockHolder(room, id)
    if (holder && pidLiveness(holder) !== 'dead') return // another runner owns this item
    writeFileSync(lockFile(room, id), String(process.pid))
  }
  const prompt = readFileSync(`${runBase(room, id)}.prompt`, 'utf8')
  const spec = run.spec
  run.state = 'running'
  run.pid = process.pid
  writeRun(room, id, run)
  const env: NodeJS.ProcessEnv = { ...process.env, ROOMS_AS: spec.who, TMPDIR: spec.scratch }
  // Codex is not the lead and not a Claude session: nothing may make it look like one.
  for (const k of ['CLAUDE_ROOMS_SESSION', 'CLAUDE_CODE_SESSION_ID', 'ROOMS_TURN']) delete env[k]
  let sawCompleted = false
  let failure = ''
  let stderr = ''
  let exit: number | null = null
  const child = spawn(codexBin(), codexArgs(spec, prompt), { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stop = () => child.kill('SIGTERM')
  process.on('SIGTERM', () => { failure ||= 'runner terminated'; stop() })
  let buf = ''
  const eventLog = `${runBase(room, id)}.jsonl`
  const onLine = (l: string) => {
    let e: any
    try { e = JSON.parse(l) } catch { return }
    run.lastEvent = e.type
    if (e.type === 'thread.started' && e.thread_id) {
      run.threadId = e.thread_id
      recordSession(room, id, e.thread_id)
    } else if (e.type === 'turn.completed') sawCompleted = true
    else if (e.type === 'turn.failed') failure = e.error?.message || 'turn failed'
    else if (e.type === 'error' && !failure) failure = e.message || ''
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
  if (buf.trim()) onLine(buf)
  run.exitCode = exit
  const it = new Room(room).find(id)
  const ok = sawCompleted && exit === 0 && !failure
  if (ok) {
    run.state = 'idle'
    if (it.get('state') === 'doing') emit(room, `${id}'s Codex turn ended but the item is still doing and no rooms done or rooms need came from it. Read its Log and Result; rooms tell ${room} --item ${id} "<what is missing>" or re-plan.`)
  } else {
    run.state = 'failed'
    run.error = failure || stderr.trim().split('\n').pop() || `codex exited with ${exit}`
    emit(room, `${id}'s Codex run failed (${run.error}). The item is still ${it.get('state')}, nothing was marked done. Check ${runBase(room, id)}.jsonl, then rooms spawn ${room} ${id} --backend codex to start again, or reassign it.`)
  }
  run.notified = true
  writeRun(room, id, run)
  try { unlinkSync(lockFile(room, id)) } catch {}
}

// Write the Codex thread id onto the item (a small load-modify-save).
function recordSession(room: string, id: string, thread: string): void {
  try {
    const it = new Room(room).find(id)
    it.set('codex_session', thread)
    it.save()
  } catch {}
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
      emit(r.name, `${id}'s Codex worker exited unexpectedly (no outcome recorded) with the item still doing. Check ${runBase(r.name, id)}.jsonl and .log, then rooms spawn ${r.name} ${id} --backend codex, or reassign.`)
      out.push(`${r.name}: ${id} codex run exited unexpectedly`)
    }
  }
  return out
}
