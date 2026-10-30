import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
  status?: string // busy | idle | ...
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

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A session is running when its process is alive; idle sessions keep theirs.
export function isRunning(s: Session | undefined): boolean {
  return !!s && pidAlive(s.pid)
}

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

export type StartOptions = { prompt: string; cwd: string; name?: string; model?: string; effort?: string; permissionMode?: string }

export function startSession(o: StartOptions): Session {
  const args = ['--bg']
  if (o.name) args.push('--name', o.name)
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode)
  args.push(o.prompt)
  const r = spawnSync(claudeBin(), args, { cwd: o.cwd, encoding: 'utf8', timeout: 60_000 })
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
  if (!sessions.length || !now) throw new Error('session state unknown; not resuming')
  if (isRunning(now)) throw new Error(`session ${s.id} is running; resuming would fork it`)
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
