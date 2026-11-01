import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Record } from '../src/record.ts'
import { codexArgs, codexLiveness } from '../src/codex.ts'

// Codex workers through the CLI with a fake codex executable.

const CLI = resolve(import.meta.dirname, '..', 'cli', 'rooms.ts')
const FAKE = resolve(import.meta.dirname, 'support', 'fake-codex.sh')

function sandbox(config?: object) {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-codex-'))
  const cfg = join(base, 'config.json')
  if (config) writeFileSync(cfg, JSON.stringify(config))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: join(base, 'state'),
    CLAUDE_ROOMS_CONFIG: config ? cfg : join(base, 'none.json'),
    CLAUDE_ROOMS_SESSION: 'lead-session-1',
    CLAUDE_ROOMS_CLAUDE: '/bin/false',
    CLAUDE_ROOMS_CODEX: FAKE,
    FAKE_CODEX_LOG: join(base, 'codex.log'),
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  const rooms = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  const ok = (...args: string[]) => {
    const r = rooms(...args)
    assert.equal(r.code, 0, `rooms ${args.join(' ')} failed: ${r.err}`)
    return r.out
  }
  const repo = join(base, 'proj')
  mkdirSync(repo)
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'Initial']]) spawnSync('git', ['-C', repo, ...a], { env })
  ok('init')
  ok('new', 'r', 'Room', '--repo', repo)
  ok('add', 'r', 'Build', '--cap', '2', '--acc', 'works', '--in', 'spec')
  const item = () => {
    const dir = join(env.CLAUDE_ROOMS_HOME!, 'r', 'items')
    return new Record('x', readFileSync(join(dir, readdirSync(dir).find(f => f.startsWith('T01-'))!), 'utf8'))
  }
  const inbox = () => {
    try { return readFileSync(join(env.CLAUDE_ROOMS_STATE!, 'rooms', 'r', 'inbox.jsonl'), 'utf8') } catch { return '' }
  }
  const wait = async (f: () => boolean, ms = 8000) => {
    const t = Date.now()
    while (!f() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50))
    assert.ok(f(), 'timed out')
  }
  const runFile = join(env.CLAUDE_ROOMS_STATE!, 'runs', 'r', 'T01.json')
  const run = () => JSON.parse(readFileSync(runFile, 'utf8'))
  return { env, rooms, ok, item, inbox, wait, run, runFile, repo, base }
}

test('codex spawn starts codex exec --json in the worktree with brief, no Claude flags; record stores backend', async () => {
  const s = sandbox({ codex: { model: 'gpt-x', effort: 'high' } })
  const out = s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  assert.match(out, /codex run/)
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'idle')
  const log = readFileSync(s.env.FAKE_CODEX_LOG!, 'utf8')
  assert.match(log, /ARGS:exec --json -s workspace-write -c approval_policy="never" -m gpt-x -c model_reasoning_effort="high" -C /)
  assert.doesNotMatch(log, /--permission-mode|--disallowedTools|--effort|claude-/)
  assert.match(log, /--add-dir /)
  assert.match(log, /Acceptance:\n- \[ \] works/)
  assert.match(log, /rooms need r T01/)
  assert.match(log, /ROOMS_AS:implementer|ROOMS_AS:worker/)
  assert.match(log, /SESSION:none/)
  const it = s.item()
  assert.equal(it.get('backend'), 'codex')
  assert.match(it.get('agent'), /^codex:c/)
  assert.equal(it.get('state'), 'doing')
  assert.equal(it.get('codex_session'), 'thread-abc')
  assert.equal(s.run().threadId, 'thread-abc')
  // a finished turn with the item still doing is reported to the lead, never marked done
  assert.match(s.inbox(), /Codex turn ended but the item is still doing/)
  assert.equal(it.get('state'), 'doing')
})

test('default backend is claude: no backend field, claude path is taken', () => {
  const s = sandbox({ codex: { model: 'gpt-x' } })
  const r = s.rooms('spawn', 'r', 'T01')
  assert.match(r.err, /claude --bg failed/)
  assert.equal(s.item().has('backend'), false)
  assert.equal(existsSync(s.env.FAKE_CODEX_LOG!), false)
  assert.equal(s.rooms('spawn', 'r', 'T01', '--backend', 'nope').code, 2)
})

test('codex ignores Claude tiers and permission flags', () => {
  const s = sandbox({ worker: { tier: 'standard' } })
  const r = s.rooms('spawn', 'r', 'T01', '--backend', 'codex', '--permission-mode', 'auto')
  assert.notEqual(r.code, 0)
  assert.match(r.err, /Claude flag/)
  const args = codexArgs({ cwd: '/w', who: 'x', scratch: '/s', sandbox: 'workspace-write', addDirs: [] }, 'p')
  assert.deepEqual(args.slice(-4), ['-C', '/w', '--', 'p'])
  assert.ok(!args.includes('-m') && !args.some(a => a.includes('model_reasoning_effort')))
})

test('a failed run and a crashed runner are reported and never mark the item done', async () => {
  const s = sandbox()
  s.env.FAKE_CODEX_MODE = 'fail'
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'failed')
  assert.match(s.inbox(), /Codex run failed \(bad model\)/)
  assert.equal(s.item().get('state'), 'doing')
  // dead run: respawn allowed
  s.env.FAKE_CODEX_MODE = 'ok'
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => s.run().state === 'idle')
})

test('a duplicate spawn is refused while the run is live, also after the server restarts; unknown liveness never spawns', async () => {
  const s = sandbox()
  s.env.FAKE_CODEX_MODE = 'hang'
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'running' && s.run().threadId)
  // every CLI call is a fresh process: nothing is held in memory
  const dup = s.rooms('spawn', 'r', 'T01', '--backend', 'codex')
  assert.match(dup.err, /already has a live worker/)
  assert.match(s.ok('status', 'r'), /T01/)
  assert.equal(codexLiveness('r', 'T01').live, 'unknown') // this process points at another state dir
  // run record lost: unknown, refused without --force
  const { rmSync } = await import('node:fs')
  const saved = readFileSync(s.runFile, 'utf8')
  rmSync(s.runFile)
  const unk = s.rooms('spawn', 'r', 'T01', '--backend', 'codex')
  assert.match(unk.err, /may be alive/)
  writeFileSync(s.runFile, saved)
  // kill -9 the runner: codex lives on in its own process group, so it is still a live worker
  const dead = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
  const { pid, codexPid } = s.run()
  assert.ok(codexPid)
  process.kill(pid, 'SIGKILL')
  await s.wait(() => dead(pid))
  s.ok('sweep')
  assert.equal(s.run().state, 'running')
  assert.doesNotMatch(s.inbox(), /exited unexpectedly/)
  assert.match(s.rooms('spawn', 'r', 'T01', '--backend', 'codex').err, /already has a live worker/)
  // once codex is gone too, sweep reports the unexpected exit, once
  process.kill(-codexPid, 'SIGKILL')
  await s.wait(() => { try { process.kill(-codexPid, 0); return false } catch { return true } })
  s.ok('sweep')
  assert.equal(s.run().state, 'failed')
  const count = () => s.inbox().split('\n').filter(l => /exited unexpectedly/.test(l)).length
  assert.equal(count(), 1)
  s.ok('sweep')
  assert.equal(count(), 1)
})

test('codex that exits nonzero without an outcome is a failed run; rooms done from codex is not re-flagged', async () => {
  const s = sandbox()
  s.env.FAKE_CODEX_MODE = 'crash'
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'failed')
  assert.match(s.inbox(), /Codex run failed \(codex exited with 3\)/)
  assert.equal(s.item().get('state'), 'doing')
  s.env.FAKE_CODEX_MODE = 'done'
  s.env.FAKE_CODEX_DONE = `${process.execPath} --no-warnings ${CLI} set r T01 state=review`
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => s.run().state === 'idle')
  assert.equal(s.item().get('state'), 'review')
  assert.equal((s.inbox().match(/turn ended but the item is still doing/g) ?? []).length, 0)
  // the respawn did not duplicate the Worktree line in the prompt
  const prompt = readFileSync(join(s.env.CLAUDE_ROOMS_STATE!, 'runs', 'r', 'T01.prompt'), 'utf8')
  assert.equal(prompt.split('- Worktree:').length - 1, 1)
})

test('codex sandbox covers the worktree git dir and the rooms git; network only when asked', async () => {
  const s = sandbox()
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'idle')
  const args = readFileSync(s.env.FAKE_CODEX_LOG!, 'utf8').split('\n').find(l => l.startsWith('ARGS:'))!
  assert.match(args, /--add-dir \S+\/\.git\/worktrees\/\S+/)
  assert.match(args, /--add-dir \S+\/rooms\/\.git(?: |$)/)
  assert.doesNotMatch(args, /network_access/)
  const a = codexArgs({ cwd: '/w', who: 'x', scratch: '/s', sandbox: 'workspace-write', addDirs: [], network: true }, 'p')
  assert.ok(a.includes('sandbox_workspace_write.network_access=true'))
})

test('rooms done still tells the lead when scratch removal fails; the runner removes scratch once the item is done', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
  const s = sandbox()
  s.ok('spawn', 'r', 'T01', '--backend', 'codex')
  await s.wait(() => existsSync(s.runFile) && s.run().state === 'idle')
  const scratch = join(s.env.CLAUDE_ROOMS_STATE!, 'scratch', 'r', 'T01')
  assert.ok(existsSync(scratch))
  const file = join(s.env.CLAUDE_ROOMS_HOME!, 'r', 'items', readdirSync(join(s.env.CLAUDE_ROOMS_HOME!, 'r', 'items')).find(f => f.startsWith('T01-'))!)
  writeFileSync(file, readFileSync(file, 'utf8').replace(/## Result[\s\S]*$/, '## Result\nDone: x\nArtifacts: x\nUnverified: x\nNext: none (test)\n'))
  const parent = join(s.env.CLAUDE_ROOMS_STATE!, 'scratch', 'r')
  chmodSync(parent, 0o555)
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'done', 'r', 'T01', '--force'], { env: { ...s.env, CLAUDE_ROOMS_SESSION: 'some-worker' }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /T01: done; lead told/)
    assert.match(s.inbox(), /T01 \(Build\) is done/)
    assert.ok(existsSync(scratch), 'removal failed, folder remains')
  } finally {
    chmodSync(parent, 0o755)
  }
  // a run that ends with the item done sheds the scratch folder itself
  s.env.FAKE_CODEX_MODE = 'done'
  s.env.FAKE_CODEX_DONE = `${process.execPath} --no-warnings ${CLI} set r T01 state=done`
  s.ok('spawn', 'r', 'T01', '--backend', 'codex', '--force')
  await s.wait(() => s.run().state === 'idle' && !existsSync(scratch))
})
