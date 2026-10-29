import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Record } from '../src/record.ts'

// End to end through the CLI, in a fresh rooms home per test. `claude` is
// replaced by /bin/false: no session list, so nothing is ever started.

const CLI = resolve(import.meta.dirname, '..', 'cli', 'rooms.ts')

function sandbox() {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-test-'))
  const env = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: join(base, 'state'),
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_SESSION: 'lead-session-1',
    CLAUDE_ROOMS_CLAUDE: '/bin/false',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
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
  const file = (room: string, sub: string, id: string) => {
    const dir = join(env.CLAUDE_ROOMS_HOME, room, sub)
    return join(dir, readdirSync(dir).find(f => f.startsWith(id + '-'))!)
  }
  ok('init')
  return { env, rooms, ok, file, home: env.CLAUDE_ROOMS_HOME }
}

test('records round-trip older files, inline comments included', () => {
  const text = '---\nid: T01\nstate: done            # todo | doing\nagent:                thread:x # session id\ndepends_on: [T02, T03]\n---\n## Log\n- 04:10Z lead: created\n\n## Result\nDone: yes\n'
  const r = new Record('/dev/null', text)
  assert.equal(r.get('state'), 'done')
  assert.equal(r.get('agent'), 'thread:x')
  assert.deepEqual(r.list('depends_on'), ['T02', 'T03'])
  assert.equal(r.section('Result'), 'Done: yes')
  r.set('state', 'review')
  assert.match(r.toString(), /^state: review            # todo \| doing$/m)
  assert.equal(new Record('/dev/null', '---\n---\nbody').preamble, 'body')
})

test('a feature room locks building until the PRD is agreed; research may run', () => {
  const s = sandbox()
  s.ok('new', 'demo', 'Demo', '--feature')
  s.ok('add', 'demo', 'Survey', '--research', '--cap', '2', '--acc', 'notes written', '--in', 'brief')
  s.ok('add', 'demo', 'Build', '--cap', '3', '--acc', 'works', '--in', 'PRD')
  assert.match(s.rooms('set', 'demo', 'T02', 'state=doing').err, /Only research items start/)
  s.ok('set', 'demo', 'T01', 'state=doing')
  assert.match(s.rooms('add', 'demo', 'Big research', '--research', '--cap', '6').err, /capped at 4h/)
  assert.match(s.rooms('prd', 'demo', 'review').err, /sign the PRD first/)
  const prd = join(s.home, 'demo', 'PRD.md')
  writeFileSync(prd, readFileSync(prd, 'utf8').replace(/^Lead:$/m, 'Lead: Ana, today').replace(/## Open questions[\s\S]*?(?=## Sign-off)/, ''))
  assert.match(s.ok('prd', 'demo', 'review'), /Agree PRD is on the owner's page/)
  assert.match(s.ok('answer', 'demo', 'D01', 'a', '--quote', 'D01 a'), /building is open/)
  s.ok('set', 'demo', 'T02', 'state=doing')
  assert.match(readFileSync(prd, 'utf8'), /^status: agreed/m)
})

test('who gets a card: one-way to the owner, two-way goes ahead by default, roles stay off the page', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  assert.match(s.rooms('ask', 'r', 'Postgres?', '-o', 'yes', '-o', 'no').err, /goes ahead by default/)
  assert.match(s.ok('ask', 'r', 'Postgres?', '-o', 'yes', '-o', 'no', '--default', 'a', '--due', '5m'), /goes ahead with a/)
  assert.match(s.ok('ask', 'r', 'Ship?', '-o', 'yes', '-o', 'no', '--door', 'one'), /on the owner's page/)
  assert.match(s.ok('ask', 'r', 'Index?', '-o', 'btree', '-o', 'gin', '--decider', 'techlead'), /not on the page/)
  assert.match(s.rooms('ask', 'r', 'Token', '--todo').err, /needs --steps/)
  const due = new Record(s.file('r', 'decisions', 'D01'), readFileSync(s.file('r', 'decisions', 'D01'), 'utf8'))
  assert.equal(due.get('status'), 'provisional')
  // At least 30 minutes, whatever was asked.
  assert.ok(Date.parse(due.get('due')) - Date.now() > 29 * 60_000)
})

test('due defaults apply in the sweep, and the lead hears it', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  s.ok('ask', 'r', 'Postgres?', '-o', 'yes', '-o', 'no', '--default', 'b')
  const f = s.file('r', 'decisions', 'D01')
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^due: .*$/m, 'due: 2020-01-01T00:00Z'))
  assert.match(s.ok('sweep'), /went ahead D01/)
  assert.match(readFileSync(f, 'utf8'), /^b · default · .* · went ahead by default$/m)
  s.ok('hook', 'poll', '--session', 'lead-session-1')
  const ev = JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1', '--take'))
  assert.match(ev.events, /went ahead with its default/)
})

test('workers: done needs a Result and a successor; need blocks and tells the lead', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R', '--session', 'someone-else')
  s.ok('add', 'r', 'Build', '--cap', '1', '--acc', 'works', '--in', 'spec')
  s.ok('set', 'r', 'T01', 'state=doing')
  assert.match(s.rooms('done', 'r', 'T01').err, /write the Result first/)
  const f = s.file('r', 'items', 'T01')
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^Done:$/m, 'Done: built').replace(/^Next:$/m, 'Next: later'))
  assert.match(s.rooms('done', 'r', 'T01', '--review').err, /Next: must name/)
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^Next: later$/m, 'Next: none (last item)'))
  assert.match(s.ok('done', 'r', 'T01', '--review'), /review; lead told/)
  s.ok('add', 'r', 'Wire', '--cap', '1', '--acc', 'wired', '--in', 'T01')
  assert.match(s.ok('need', 'r', 'T02', 'needs the schema'), /blocked; lead told/)
  assert.match(readFileSync(s.file('r', 'items', 'T02'), 'utf8'), /^state: blocked/m)
})

test("the owner's 'D05 b' in chat is recorded before the lead reads it", () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  s.ok('ask', 'r', 'Ship?', '-o', 'yes', '-o', 'no', '--door', 'one')
  assert.match(s.ok('hook', 'prompt', '--session', 'lead-session-1', '--said', 'D01 b please'), /Recorded .* D01 b/)
  assert.match(readFileSync(s.file('r', 'decisions', 'D01'), 'utf8'), /^b · human · .* · in chat/m)
  // Not the lead: nothing happens.
  assert.equal(s.ok('hook', 'prompt', '--session', 'nobody', '--said', 'D01 a'), '')
})

test('status: a room with ready work and nobody on it is stuck; --yield exits 1', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  s.ok('add', 'r', 'Build', '--cap', '1', '--acc', 'works', '--in', 'spec')
  const st = JSON.parse(s.ok('status', 'r', '--json'))[0]
  assert.equal(st.status, 'stuck')
  assert.deepEqual(st.ready, ['T01'])
  assert.equal(s.rooms('status', 'r', '--yield').code, 1)
  s.ok('set', 'r', 'T01', 'state=dropped')
  assert.equal(JSON.parse(s.ok('status', 'r', '--json'))[0].status, 'idle')
})

test('events: one delivery for many, receipts follow them', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  s.ok('hook', 'poll', '--session', 'lead-session-1') // holds the lease
  s.ok('tell', 'r', 'one')
  s.ok('tell', 'r', 'two')
  const ev = JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1', '--take')).events
  assert.match(ev, /2 new events/)
  assert.equal(JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1', '--take')).events, '')
})
