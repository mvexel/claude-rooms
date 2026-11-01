import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER_DISALLOWED_TOOLS, untrustedFolder, isEnded, isRunning, liveness, startArgs } from '../src/sessions.ts'

const kill = process.kill
const killing = (code: string | null) => {
  process.kill = ((() => {
    if (code) throw Object.assign(new Error(code), { code })
    return true
  }) as unknown) as typeof process.kill
}
test.afterEach(() => { process.kill = kill })

function registry(pid: number, sessionId: string) {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-'))
  mkdirSync(join(home, 'sessions'))
  writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId }))
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.HOME = home
}

test('EPERM from kill(pid, 0) means alive; ESRCH means dead', () => {
  killing('EPERM')
  assert.equal(isRunning({ id: 'a', sessionId: 'a', pid: 42 }), true)
  killing('ESRCH')
  assert.equal(isEnded({ id: 'a', sessionId: 'a', pid: 42 }), true)
})

test('a sandboxed entry without pid is looked up in the session registry', () => {
  registry(777, 'sid-1')
  killing('EPERM')
  assert.equal(liveness({ id: 's', sessionId: 'sid-1', state: 'failed' }), 'alive')
  killing('ESRCH')
  assert.equal(liveness({ id: 's', sessionId: 'sid-1', state: 'failed' }), 'dead')
})

test('unknown liveness is never reported as ended', () => {
  registry(777, 'other')
  assert.equal(liveness({ id: 's', sessionId: 'sid-2', state: 'failed' }), 'unknown')
  assert.equal(liveness(undefined), 'unknown')
  assert.equal(isEnded({ id: 's', sessionId: 'sid-2' }), false)
  assert.equal(isRunning({ id: 's', sessionId: 'sid-2' }), false)
  assert.equal(liveness({ id: 's', sessionId: 'sid-2', state: 'stopped' }), 'dead')
})

test('a list where some entry has a pid is unsandboxed: absent or unregistered sessions are dead', () => {
  registry(777, 'other')
  killing('ESRCH')
  const unsandboxed = [{ id: 'x', sessionId: 'x-1', pid: 5 }, { id: 'g', sessionId: 'gone-1', state: 'failed' }]
  assert.equal(liveness('gone-1', unsandboxed), 'dead')
  assert.equal(liveness('never-listed', unsandboxed), 'dead')
  assert.equal(liveness(unsandboxed[1], unsandboxed), 'dead')
  const sandboxed = [{ id: 'g', sessionId: 'gone-1', state: 'failed' }]
  assert.equal(liveness('gone-1', sandboxed), 'unknown')
  assert.equal(liveness('never-listed', []), 'unknown')
})

test('a session the sandboxed list omits is found in the registry by id or prefix', () => {
  registry(888, 'abcdef12-0000-0000-0000-000000000000')
  killing('EPERM')
  assert.equal(liveness('abcdef12-0000-0000-0000-000000000000', []), 'alive')
  assert.equal(liveness('abcdef12', [{ id: 'z', sessionId: 'z', state: 'failed' }]), 'alive')
  killing('ESRCH')
  assert.equal(liveness('abcdef12', []), 'dead')
})

test('worker spawn args disable AskUserQuestion and EnterWorktree; lead spawn args do not', () => {
  const w = startArgs({ prompt: 'go', cwd: '.', disallowedTools: WORKER_DISALLOWED_TOOLS })
  assert.deepEqual(w.slice(w.indexOf('--disallowedTools=AskUserQuestion,EnterWorktree')), ['--disallowedTools=AskUserQuestion,EnterWorktree', 'go'])
  assert.ok(!w.includes('--disallowedTools')) // a bare variadic flag would swallow the prompt
  assert.ok(!startArgs({ prompt: 'go', cwd: '.' }).includes('--disallowedTools'))
})

test('untrustedFolder: a folder is trusted by itself or an ancestor; else it is named', () => {
  const home = mkdtempSync(join(tmpdir(), 'trust-'))
  const cfg = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    assert.equal(untrustedFolder('/x/repo-wt'), undefined) // no config: claude decides
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/x/trusted': { hasTrustDialogAccepted: true }, '/x/no': { hasTrustDialogAccepted: false } } }))
    assert.equal(untrustedFolder('/x/trusted/sub/wt'), undefined)
    assert.equal(untrustedFolder('/x/no'), '/x/no')
    assert.equal(untrustedFolder('/x/trusted-wt'), '/x/trusted-wt') // beside, not under
    assert.equal(untrustedFolder('/x/trusted-room-t01', '/x/trusted'), undefined) // a worktree shares its repo's trust
    assert.equal(untrustedFolder('/x/no-room-t01', '/x/no'), '/x/no-room-t01')
  } finally {
    if (cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = cfg
  }
})
