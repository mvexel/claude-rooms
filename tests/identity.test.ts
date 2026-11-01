import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Room } from '../src/room.ts'
const CLI = resolve(import.meta.dirname, '..', 'cli', 'rooms.ts')
import { identity } from '../src/identity.ts'
import { agentDetail } from '../src/server.ts'

const sid = (n: number) => `${n.toString(16).padStart(8, '0')}-7329-45a8-97a4-85ae7e70c9cd`

test('identity is deterministic per session id', () => {
  assert.deepEqual(identity(sid(1)), identity(sid(1)))
  assert.equal(identity(sid(1)).svg, identity(sid(1).toUpperCase()).svg)
})

test('different sessions mostly differ; names are two words', () => {
  const ids = Array.from({ length: 60 }, (_, k) => identity(sid(k)))
  assert.ok(new Set(ids.map(i => i.name)).size > 40)
  assert.ok(new Set(ids.map(i => i.svg)).size > 55)
  for (const i of ids) assert.match(i.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
})

test('avatar is inline svg, mirrored, with no external references or script', () => {
  const { svg } = identity(sid(7))
  assert.match(svg, /^<svg [^>]*viewBox/)
  assert.doesNotMatch(svg, /<script|href=|url\(|<image/)
  const xs = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map(m => `${m[1]},${m[2]}`)
  for (const c of xs) { const [x, y] = c.split(',').map(Number); assert.ok(xs.includes(`${4 - x},${y}`)) }
})

test('agentDetail is exported', () => assert.equal(typeof agentDetail, 'function'))

test('avatar fill takes its lightness from --av-l, with a light-theme default', () => {
  const { svg } = identity(sid(3))
  assert.match(svg, /fill:hsl\(\d+ 65% var\(--av-l,30%\)\)/)
  assert.doesNotMatch(svg, /<g fill=/)
})

test('agentDetail on a fixture room: lead, worker with two items, charter', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'identity-test-'))
  const env = { ...process.env, CLAUDE_ROOMS_HOME: join(base, 'rooms'), CLAUDE_ROOMS_STATE: join(base, 'state'), CLAUDE_ROOMS_CONFIG: join(base, 'none.json'), CLAUDE_ROOMS_SESSION: 'lead-session-1', CLAUDE_ROOMS_CLAUDE: '/bin/false' }
  const cli = (...a: string[]) => { const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...a], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  cli('init'); cli('new', 'r', 'R')
  cli('add', 'r', 'One', '--owner', 'builder', '--acc', 'a', '--in', 'brief')
  cli('add', 'r', 'Two', '--owner', 'builder', '--acc', 'a', '--in', 'brief')
  const worker = 'abcd1234-0000-4000-8000-000000000001'
  cli('set', 'r', 'T01', `agent=${worker}`, 'state=done'); cli('set', 'r', 'T02', `agent=${worker}`, 'state=doing')
  const previous = process.env.CLAUDE_ROOMS_HOME
  process.env.CLAUDE_ROOMS_HOME = env.CLAUDE_ROOMS_HOME
  try {
    const room = new Room('r')
    const brief = room.brief
    brief.setSection('Team', '- builder: standard tier. Builds one item at a time;\n  never merges.\n- reviewer: review tier.')
    brief.save()
    const a = agentDetail(new Room('r'), 'abcd1234', [])!
    assert.equal(a.role, 'builder')
    assert.equal(a.received, 2)
    assert.equal(a.completed, 1)
    assert.equal(a.name, identity(worker).name)
    assert.equal(a.charter, 'standard tier. Builds one item at a time; never merges.')
    assert.equal(agentDetail(new Room('r'), 'nope', []), undefined)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ROOMS_HOME
    else process.env.CLAUDE_ROOMS_HOME = previous
  }
})
