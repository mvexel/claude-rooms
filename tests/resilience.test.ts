import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Backend, useBackend, localBackend, routed, routingActive } from '../src/backend.ts'
import { withLock } from '../src/git.ts'
import { run } from '../src/commands.ts'

function sandbox() {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-resil-'))
  process.env.CLAUDE_ROOMS_HOME = join(home, 'rooms')
  process.env.CLAUDE_ROOMS_STATE = join(home, 'state')
  delete process.env.CLAUDE_ROOMS_BACKEND
  mkdirSync(process.env.CLAUDE_ROOMS_HOME, { recursive: true })
  return home
}

test('N1: a claim keeps its id on disk until the hub has answered, so a killed hook asks again with it', () => {
  const home = sandbox()
  const ids: (string | undefined)[] = []
  let kill = true
  const remote: Backend = {
    ...localBackend,
    claim(_p, id) {
      ids.push(id)
      if (kill) throw new Error('killed before the reply')
      return 'lines\n'
    },
  }
  const b = routed(localBackend, remote, ['hubbed'])
  const inbox = join(home, 'state', 'rooms', 'hubbed', 'inbox.jsonl')
  assert.throws(() => b.claim(inbox))
  assert.throws(() => b.claim(inbox))
  kill = false
  assert.equal(b.claim(inbox), 'lines\n')
  assert.equal(b.claim(inbox), 'lines\n')
  assert.equal(ids[0], ids[1])
  assert.equal(ids[1], ids[2])
  assert.match(ids[0]!, /^c-/)
  assert.notEqual(ids[3], ids[2], 'a claim that was answered does not reuse its id')
  assert.equal(readdirSync(join(home, 'state', 'claims')).length, 0)
})

test('N4: with the hub down, status for all rooms still shows local rooms and marks routed ones unreachable', async () => {
  const home = sandbox()
  const down = (): never => {
    throw new Error('hub unreachable (timeout)')
  }
  const remote: Backend = { read: down, write: down, append: down, exists: down, remove: down, claim: down, list: () => [{ name: 'hubbed', dir: true }] }
  mkdirSync(join(home, 'rooms', 'mine'), { recursive: true })
  writeFileSync(join(home, 'rooms', 'mine', 'BRIEF.md'), '---\ntitle: Mine\n---\n')
  useBackend(routed(localBackend, remote, ['hubbed']))
  try {
    const r = await run(['status'])
    assert.equal(r.code, 0, r.text)
    assert.match(r.text, /MINE · mine/)
    assert.match(r.text, /hubbed · UNREACHABLE: .*hub unreachable/)
    const j = JSON.parse((await run(['status', '--json'])).text)
    assert.equal(j.find((x: any) => x.room === 'hubbed').unreachable, true)
    assert.ok(j.find((x: any) => x.room === 'mine').status)
    await assert.rejects(run(['status', 'hubbed']), /hub unreachable/)
  } finally {
    useBackend(localBackend)
  }
})

test('N6: a lock whose holder died is free at once, and an orphaned .taking file is read back', () => {
  const home = sandbox()
  const lock = join(home, 'state', 'locks', 'dispatch-x.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'holder'), '99999999 2026-01-01T00:00:00Z')
  const t = Date.now()
  assert.equal(withLock('dispatch-x', () => 'ran'), 'ran')
  assert.ok(Date.now() - t < 2000)

  const inbox = join(home, 'state', 'rooms', 'r', 'inbox.jsonl')
  mkdirSync(join(home, 'state', 'rooms', 'r'), { recursive: true })
  writeFileSync(`${inbox}.99999999.taking`, 'orphan\n')
  writeFileSync(inbox, 'fresh\n')
  assert.equal(localBackend.claim(inbox), 'orphan\nfresh\n')
  assert.deepEqual(readdirSync(join(home, 'state', 'rooms', 'r')), [])
  assert.equal(existsSync(inbox), false)
})

test('N6: no routing, no watchdog', () => {
  useBackend(localBackend)
  assert.equal(routingActive(), false)
  useBackend(routed(localBackend, localBackend, ['x']))
  assert.equal(routingActive(), true)
  useBackend(localBackend)
})
