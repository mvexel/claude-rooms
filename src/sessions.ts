import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeBin, claudeDir } from './config.ts'

// Claude Code sessions, the only backend. What rooms needs maps to:
//   start   claude --bg            status  claude agents --json
//   wake    inbox + plugin, or claude --bg --resume on a session that isn't running
//   stop    claude stop
// `--resume` on a running session forks a copy, so it is never used on one.

export type Session = {
  id: string // short id, as `claude agents` prints it
  sessionId: string
  pid?: number
  cwd?: string
  name?: string
  status?: string // busy | idle | waiting | ...
  waitingFor?: string // what a 'waiting' session needs, e.g. 'input needed'
  state?: string
  kind?: string
}

export function listSessions(all = true): Session[] {
  const r = spawnSync(claudeBin(), ['agents', '--json', ...(all ? ['--all'] : [])], { encoding: 'utf8', timeout: 20_000 })
  if (r.status !== 0) return []
  try {
    return JSON.parse(r.stdout) as Session[]
  } catch {
    return []
  }
}

export function findSession(ref: string, sessions = listSessions()): Session | undefined {
  return sessions.find(s => s.sessionId === ref || s.id === ref) ?? sessions.find(s => s.sessionId.startsWith(ref))
}

export type Liveness = 'alive' | 'dead' | 'unknown'

// kill(pid, 0): EPERM means the process exists but a sandbox or another user
// forbids signalling it, so it is alive; only ESRCH means gone.
export function pidLiveness(pid: number): Liveness {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EPERM' ? 'alive' : code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

// ~/.claude/sessions/<pid>.json maps pid to sessionId and stays readable in a
// sandbox that strips pid and status from `claude agents`.
function registryPid(ref: string): number | undefined {
  if (!ref) return undefined
  try {
    const dir = join(claudeDir(), 'sessions')
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue
      try {
        const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (typeof e.sessionId === 'string' && e.sessionId.startsWith(ref) && Number(e.pid) > 0) return Number(e.pid)
      } catch {}
    }
  } catch {}
  return undefined
}

// Is the session's process alive? A pid (listed, else from the registry,
// which a sandbox leaves readable) decides. Without one, a list where any
// entry carries a pid was not sandboxed, so a session it lacks or shows
// pid-less and unregistered is gone. A list with no pids at all (sandboxed,
// or `claude agents` failed) proves nothing, so liveness stays unknown unless
// the entry itself says it finished.
export function liveness(who: Session | string | undefined, sessions: Session[] = []): Liveness {
  if (!who) return 'unknown'
  const s = typeof who === 'string' ? findSession(who, sessions) : who
  const pid = s?.pid ?? registryPid(s?.sessionId ?? (who as string))
  if (pid) return pidLiveness(pid)
  if (sessions.some(x => x.pid)) return 'dead'
  return s && (s.state === 'done' || s.state === 'stopped') ? 'dead' : 'unknown'
}

export const isRunning = (who: Session | string | undefined, sessions: Session[] = []): boolean => liveness(who, sessions) === 'alive'
export const isEnded = (who: Session | string | undefined, sessions: Session[] = []): boolean => liveness(who, sessions) === 'dead'

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  } catch {
    try {
      return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    } catch {
      return undefined
    }
  }
}

// The Claude Code session this process runs under: the id Claude Code hands
// its tool processes, else walk up the process tree to a pid that has a
// registry entry in ~/.claude/sessions/<pid>.json (`ps` may be sandboxed).
export function currentSessionId(): string | undefined {
  if (process.env.CLAUDE_ROOMS_SESSION) return process.env.CLAUDE_ROOMS_SESSION
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID
  let pid: number | undefined = process.pid
  for (let i = 0; i < 20 && pid && pid > 1; i++) {
    const file = join(claudeDir(), 'sessions', `${pid}.json`)
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).sessionId
      } catch {}
    }
    pid = parentPid(pid)
  }
  return undefined
}

// Workers can't ask the owner; the plugin's tool.call hook denies it too.
export const WORKER_DISALLOWED_TOOLS = 'AskUserQuestion'

export function startArgs(o: StartOptions): string[] {
  const args = ['--bg']
  if (o.name) args.push('--name', o.name)
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode)
  if (o.disallowedTools) args.push('--disallowedTools', o.disallowedTools)
  args.push(o.prompt)
  return args
}

export type StartOptions = { prompt: string; cwd: string; name?: string; model?: string; effort?: string; permissionMode?: string; disallowedTools?: string }

export function startSession(o: StartOptions): Session {
  const r = spawnSync(claudeBin(), startArgs(o), { cwd: o.cwd, encoding: 'utf8', timeout: 60_000 })
  const out = `${r.stdout}\n${r.stderr}`
  const m = out.match(/backgrounded · ([0-9a-f]{6,})/)
  if (r.status !== 0 || !m) throw new Error(`claude --bg failed: ${out.trim().split('\n').pop()}`)
  return findSession(m[1]) ?? { id: m[1], sessionId: m[1], name: o.name, cwd: o.cwd }
}

// Resume a session with a message as its next turn, only when the session
// list is known and says it isn't running: `--resume` on a running session
// forks it, and on an unknown one might.
export function resumeStopped(s: Session, text: string, sessions: Session[]): void {
  const now = sessions.find(x => x.sessionId === s.sessionId)
  if (!sessions.length) throw new Error('session state unknown; not resuming')
  if (!isEnded(s.sessionId, sessions)) throw new Error(`session ${s.id} is ${isRunning(s.sessionId, sessions) ? 'running; resuming would fork it' : 'of unknown liveness; not resuming'}`)
  const r = spawnSync(claudeBin(), ['--bg', '--resume', s.sessionId, text], {
    cwd: s.cwd && existsSync(s.cwd) ? s.cwd : undefined,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const out = `${r.stdout}\n${r.stderr}`
  if (r.status !== 0 || /started a copy/.test(out)) throw new Error(`resume failed: ${out.trim().split('\n').pop()}`)
}

export function stopSession(s: Session): void {
  spawnSync(claudeBin(), ['stop', s.id], { encoding: 'utf8', timeout: 30_000 })
}
