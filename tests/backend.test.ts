import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Backend, useBackend, localBackend } from '../src/backend.ts'
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
