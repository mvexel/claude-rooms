import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Backend, useBackend, localBackend, routed } from '../src/backend.ts'
import { Record } from '../src/record.ts'
import { Room } from '../src/room.ts'
import { emit, pending, take } from '../src/events.ts'

const CLI = resolve(import.meta.dirname, '..', 'cli', 'rooms.ts')

function memory(): Backend & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: p => files.get(p),
    write: (p, t) => void files.set(p, t),
    append: (p, t) => void files.set(p, (files.get(p) ?? '') + t),
    exists: p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    list(dir) {
      const out = new Map<string, boolean>()
      for (const k of files.keys()) {
        if (!k.startsWith(dir + '/')) continue
        const [name, ...rest] = k.slice(dir.length + 1).split('/')
        out.set(name, rest.length > 0)
      }
      return [...out].map(([name, dir]) => ({ name, dir }))
    },
    remove(p) {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k)
    },
    claim(p) {
      const t = files.get(p)
      files.delete(p)
      return t
    },
  }
}

test('records, rooms and the inbox work on a backend that is not files', () => {
  const mem = memory()
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-backend-'))
  process.env.CLAUDE_ROOMS_HOME = join(home, 'rooms')
  process.env.CLAUDE_ROOMS_STATE = join(home, 'state')
  useBackend(mem)
  try {
    const brief = new Record(join(home, 'rooms', 'demo', 'BRIEF.md'), '---\n---\n')
    brief.set('title', 'Demo')
    brief.save()
    const room = new Room('demo')
    room.create('items', 'T01', 'First thing', [['state', 'todo']], [['Log', '- created']])
    assert.deepEqual(Room.all().map(r => r.name), ['demo'])
    assert.equal(room.find('T01').get('state'), 'todo')
    assert.equal(room.nextId('T'), 'T02')
    assert.ok([...mem.files.keys()].every(k => k.startsWith(home)))

    const id = emit('demo', 'hello', { dispatch: false })
    assert.deepEqual(pending('demo').map(e => e.id), [id])
    assert.deepEqual(take('demo').map(e => e.text), ['hello'])
    assert.deepEqual(pending('demo'), [])
  } finally {
    useBackend(localBackend)
    delete process.env.CLAUDE_ROOMS_HOME
    delete process.env.CLAUDE_ROOMS_STATE
  }
})

test('CLAUDE_ROOMS_BACKEND names the module every record read and write goes through', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-backend-'))
  const log = join(base, 'calls.log')
  const env = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: join(base, 'state'),
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_CLAUDE: '/bin/false',
    CLAUDE_ROOMS_BACKEND: resolve(import.meta.dirname, 'support', 'logging-backend.ts'),
    BACKEND_LOG: log,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  const rooms = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })
  assert.equal(rooms('init').status, 0)
  const made = rooms('new', 'demo', '--title', 'Demo', '--lead', 'lead-1')
  assert.equal(made.status, 0, made.stderr + made.stdout)
  const add = rooms('add', 'demo', 'Do a thing')
  assert.equal(add.status, 0, add.stderr + add.stdout)
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /^write .*demo\/BRIEF\.md$/m)
  assert.match(calls, /^write .*demo\/items\/T01-do-a-thing\.md$/m)
  assert.match(calls, /^list .*demo\/items$/m)
})

test('a backend module missing a method is refused with its name', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'status'], {
    env: { ...process.env, CLAUDE_ROOMS_BACKEND: resolve(import.meta.dirname, '..', 'src', 'config.ts') },
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /CLAUDE_ROOMS_BACKEND .*no read\(\)/)
})

test('routed rooms go to the module, other rooms stay local, listings merge', () => {
  const remote = memory()
  const local = memory()
  const home = '/r/rooms'
  const state = '/r/state'
  process.env.CLAUDE_ROOMS_HOME = home
  process.env.CLAUDE_ROOMS_STATE = state
  try {
    const b = routed(local, remote, ['hub'])
    b.write(`${home}/hub/BRIEF.md`, 'h')
    b.write(`${home}/mine/BRIEF.md`, 'm')
    b.append(`${state}/rooms/hub/inbox.jsonl`, 'x\n')
    b.append(`${state}/rooms/mine/inbox.jsonl`, 'y\n')
    b.write(`${state}/scratch/hub/T01/f`, 'scratch') // not a room key: local
    assert.deepEqual([...remote.files.keys()].sort(), [`${home}/hub/BRIEF.md`, `${state}/rooms/hub/inbox.jsonl`])
    assert.deepEqual([...local.files.keys()].sort(), [`${home}/mine/BRIEF.md`, `${state}/rooms/mine/inbox.jsonl`, `${state}/scratch/hub/T01/f`])
    assert.equal(b.read(`${home}/hub/BRIEF.md`), 'h')
    assert.equal(b.read(`${home}/mine/BRIEF.md`), 'm')
    assert.equal(b.claim(`${state}/rooms/hub/inbox.jsonl`), 'x\n')
    assert.equal(b.exists(`${state}/rooms/hub/inbox.jsonl`), false)
    // a stale local copy of a routed room is not listed; the routed one is
    local.write(`${home}/hub/BRIEF.md`, 'stale')
    remote.write(`${home}/other/BRIEF.md`, 'not listed in the file')
    assert.deepEqual(b.list(home).map(e => e.name).sort(), ['hub', 'mine'])
    assert.equal(b.exists(`${home}/hub`), true)
    b.remove(`${home}/hub`)
    assert.equal(b.read(`${home}/hub/BRIEF.md`), undefined)
    assert.equal(local.read(`${home}/hub/BRIEF.md`), 'stale')
    // removed from the list: local again
    const back = routed(local, remote, [])
    assert.equal(back.read(`${home}/hub/BRIEF.md`), 'stale')
    assert.deepEqual(back.list(home).map(e => e.name).sort(), ['hub', 'mine'])
  } finally {
    delete process.env.CLAUDE_ROOMS_HOME
    delete process.env.CLAUDE_ROOMS_STATE
  }
})

test('STATE/backend.json routes the listed rooms for the CLI; the env var wins; no file means files', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-routing-'))
  const log = join(base, 'calls.log')
  const state = join(base, 'state')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: state,
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_CLAUDE: '/bin/false',
    BACKEND_LOG: log,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  delete env.CLAUDE_ROOMS_BACKEND
  const rooms = (e: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env: e, encoding: 'utf8' })
  const repo = (name: string) => {
    const dir = join(base, name)
    mkdirSync(dir)
    spawnSync('git', ['init', '-q', dir])
    return dir
  }
  const ok = (...args: string[]) => {
    const r = rooms(env, ...args)
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return r.stdout
  }
  const routing = (rooms: string[]) =>
    writeFileSync(join(state, 'backend.json'), JSON.stringify({ module: resolve(import.meta.dirname, 'support', 'logging-backend.ts'), rooms, settings: { hub: 'https://hub.example' } }))
  ok('init')
  ok('new', 'mine', 'Mine', '--session', 'l1', '--repo', repo('r1'))
  assert.equal(existsSync(log), false) // no file: no module

  routing(['hubbed'])
  ok('new', 'hubbed', 'Hubbed', '--session', 'l2', '--repo', repo('r2'))
  ok('add', 'mine', 'local thing')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /^settings \{"hub":"https:\/\/hub\.example"\}$/m)
  assert.match(calls, /^write .*hubbed\/BRIEF\.md$/m)
  assert.doesNotMatch(calls, /mine\//)
  // both rooms are seen
  const status = ok('status')
  assert.match(status, /mine/)
  assert.match(status, /hubbed/)

  // env wins over the file: the file's settings are never passed
  writeFileSync(log, '')
  const viaEnv = rooms({ ...env, CLAUDE_ROOMS_BACKEND: resolve(import.meta.dirname, 'support', 'logging-backend.ts') }, 'status')
  assert.equal(viaEnv.status, 0, viaEnv.stderr)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /^settings/m)

  // removed from the list: back to local files, module not loaded
  routing([])
  writeFileSync(log, '')
  ok('add', 'hubbed', 'now local')
  assert.equal(readFileSync(log, 'utf8'), '')
})
