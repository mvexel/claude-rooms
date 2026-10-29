import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { roomsHome, stateDir } from './config.ts'

// Git for the rooms repo, and the one lock every writer that commits takes.

export function git(args: string[], cwd = roomsHome()): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const STALE_MS = 5 * 60_000

// A directory lock: mkdir is atomic. A holder older than STALE_MS is broken.
export function withLock<T>(name: string, fn: () => T): T {
  const dir = join(stateDir(), 'locks', `${name}.lock`)
  mkdirSync(join(stateDir(), 'locks'), { recursive: true })
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'holder'), `${process.pid} ${new Date().toISOString()}`)
      break
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true })
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock ${name} held: ${safeRead(join(dir, 'holder'))}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return '?'
  }
}

export function hasRemote(): boolean {
  return git(['remote']).out.length > 0
}

const pushFile = () => join(stateDir(), 'push.json')
const commitFile = () => join(stateDir(), 'last-commit')

// Commit now: one room's folder, or every room. Nothing is pushed here.
export function commit(room: string | undefined, msg: string): { sha?: string; error?: string } {
  if (!existsSync(join(roomsHome(), '.git'))) return { error: `${roomsHome()} is not a git repo: run rooms init` }
  return withLock('commit', () => {
    const paths = room ? [room] : ['.']
    git(['add', '-A', '--', ...paths])
    if (git(['diff', '--cached', '--quiet']).ok) return {}
    const c = git(['commit', '-q', '-m', msg, '--', ...paths])
    if (!c.ok) return { error: c.err.split('\n')[0] }
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(commitFile(), String(Date.now()))
    return { sha: git(['log', '--oneline', '-1']).out }
  })
}

// Writers call this after a change: it commits when the last commit is older
// than the debounce, else leaves it to the next writer or the page server's
// sweep. Then it mirrors to the remote in the background, if there is one.
export function autocommit(msg: string, debounceMs: number): void {
  let last = 0
  try {
    last = Number(readFileSync(commitFile(), 'utf8'))
  } catch {}
  if (Date.now() - last < debounceMs) return
  const r = commit(undefined, msg)
  if (r.sha) pushInBackground()
}

export function pushInBackground(): void {
  if (!hasRemote()) return
  const branch = git(['branch', '--show-current']).out || 'main'
  const script = `out=$(timeout -s KILL 60 git push -q origin ${branch} 2>&1); code=$?; printf '{"at":%s,"ok":%s,"error":%s}' "$(date +%s000)" "$([ $code = 0 ] && echo true || echo false)" "$(printf '%s' "$out" | head -c 300 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" > ${JSON.stringify(pushFile())}`
  spawn('sh', ['-c', script], { cwd: roomsHome(), detached: true, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } }).unref()
}

export function lastPush(): { at: number; ok: boolean; error: string } | undefined {
  try {
    return JSON.parse(readFileSync(pushFile(), 'utf8'))
  } catch {
    return undefined
  }
}

export function uncommitted(room: string): number {
  return git(['status', '--porcelain', '--untracked-files=all', '--', room]).out.split('\n').filter(Boolean).length
}
