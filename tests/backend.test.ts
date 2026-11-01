import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  assert.match(calls, /^settings \{"timeoutMs":8000,"hub":"https:\/\/hub\.example"\}$/m)
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

test('with the default nesting (state inside the rooms home) a routed room inbox and lease go to the module', () => {
  const remote = memory()
  const local = memory()
  const home = '/r/rooms'
  process.env.CLAUDE_ROOMS_HOME = home
  delete process.env.CLAUDE_ROOMS_STATE // default: /r/rooms/.state
  try {
    const b = routed(local, remote, ['hub'])
    b.append(`${home}/.state/rooms/hub/inbox.jsonl`, 'x\n')
    b.write(`${home}/.state/rooms/hub/lease.json`, '{}')
    b.write(`${home}/.state/rooms/hub/T01/lease.json`, '{}')
    b.append(`${home}/.state/rooms/mine/inbox.jsonl`, 'y\n')
    assert.deepEqual([...remote.files.keys()].sort(), [`${home}/.state/rooms/hub/T01/lease.json`, `${home}/.state/rooms/hub/inbox.jsonl`, `${home}/.state/rooms/hub/lease.json`])
    assert.deepEqual([...local.files.keys()], [`${home}/.state/rooms/mine/inbox.jsonl`])
  } finally {
    delete process.env.CLAUDE_ROOMS_HOME
  }
})

test('a routed room receipts also reach the module; a local room receipts do not', () => {
  const remote = memory()
  const local = memory()
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-receipts-'))
  process.env.CLAUDE_ROOMS_HOME = join(home, 'rooms') // state defaults inside it
  useBackend(routed(local, remote, ['hub']))
  try {
    const a = emit('hub', 'hello', { dispatch: false })
    const b = emit('mine', 'local', { dispatch: false })
    take('hub')
    take('mine')
    const receiptsKey = [...remote.files.keys()].find(k => k.endsWith('receipts.json'))!
    assert.ok(receiptsKey, 'module got a receipts write')
    const got = JSON.parse(remote.files.get(receiptsKey)!)
    assert.equal(got[a].delivery, 'lead_read')
    assert.equal(got[b], undefined)
    // local receipts are unchanged: both ids are there
    const mine = JSON.parse(local.files.get(receiptsKey)!)
    assert.equal(mine[a].delivery, 'lead_read')
    assert.equal(mine[b].delivery, 'lead_read')
    // the inboxes went where their rooms live
    assert.ok([...remote.files.keys()].every(k => !k.includes('/mine/')))
  } finally {
    useBackend(localBackend)
    delete process.env.CLAUDE_ROOMS_HOME
  }
})

test('a module that fails never loses the local receipt', () => {
  const local = memory()
  const remote = { ...memory(), write() { throw new Error('hub down') } } as Backend
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-receipts-'))
  process.env.CLAUDE_ROOMS_HOME = join(home, 'rooms')
  useBackend(routed(local, remote, ['other']))
  try {
    const id = emit('other', 'x', { dispatch: false }) // the hub write of the receipt throws, emit does not
    const key = [...local.files.keys()].find(k => k.endsWith('receipts.json'))!
    assert.equal(JSON.parse(local.files.get(key)!)[id].delivery, 'saved')
  } finally {
    useBackend(localBackend)
    delete process.env.CLAUDE_ROOMS_HOME
  }
})

test('a broken routing setup fails only the routed rooms; local rooms and hooks keep working', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-broken-'))
  const state = join(base, 'rooms', '.state') // default nesting
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_CLAUDE: '/bin/false',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  delete env.CLAUDE_ROOMS_BACKEND
  delete env.CLAUDE_ROOMS_STATE
  const rooms = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })
  const repo = (name: string) => {
    const dir = join(base, name)
    mkdirSync(dir)
    spawnSync('git', ['init', '-q', dir])
    return dir
  }
  const module = resolve(import.meta.dirname, 'support', 'logging-backend.ts')
  const routing = (text: string) => writeFileSync(join(state, 'backend.json'), text)
  assert.equal(rooms('init').status, 0)
  assert.equal(rooms('new', 'mine', 'Mine', '--session', 'l1', '--repo', repo('r1')).status, 0)
  const check = (label: string) => {
    const add = rooms('add', 'mine', 'local thing ' + label)
    assert.equal(add.status, 0, `${label}: ${add.stderr}`)
    assert.equal(rooms('status').status, 0, label)
    assert.equal(rooms('hook', 'poll', '--session', 'x').status, 0, label)
    const tell = rooms('tell', 'hubbed', 'hi')
    assert.notEqual(tell.status, 0, label)
  }
  // a good file once, so the room names are known; then each way to break it
  writeFileSync(join(base, 'calls.log'), '')
  env.BACKEND_LOG = join(base, 'calls.log')
  routing(JSON.stringify({ module, rooms: ['hubbed'] }))
  assert.equal(rooms('status').status, 0)
  routing(JSON.stringify({ module: '/nope/x.ts', rooms: ['hubbed'] }))
  check('bad module path')
  assert.match(rooms('tell', 'hubbed', 'hi').stderr, /hubbed.*(hub backend|failed)/s)
  routing('{ truncated')
  check('bad json')
  routing(JSON.stringify({ module, rooms: 'nope' }))
  check('bad shape')
})

test('a worker in a routed room edits a working copy in a git worktree; rooms done takes it to the hub', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-working-'))
  const state = join(base, 'state')
  const hub = join(base, 'hub') // stands in for the hub: the module stores keys as flat files here
  mkdirSync(hub)
  const fake = join(base, 'claude')
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in agents) echo '[]'; exit 0;; esac\necho "$@" > ${join(base, 'args.txt')}\necho "backgrounded · abc123"\n`)
  chmodSync(fake, 0o755)
  const mod = join(base, 'hubmod.ts')
  writeFileSync(
    mod,
    `import { localBackend } from ${JSON.stringify(resolve(import.meta.dirname, '..', 'src', 'backend.ts'))}
const dir = ${JSON.stringify(hub)}
const flat = (p: string) => p.replace(/[\\\\/]/g, '_')
const key = (p: string) => dir + '/' + flat(p)
export default () => ({
  read: (p: string) => localBackend.read(key(p)),
  write: (p: string, t: string) => localBackend.write(key(p), t),
  append: (p: string, t: string) => localBackend.append(key(p), t),
  exists: (p: string) => localBackend.exists(key(p)),
  list: (d: string) => localBackend.list(dir).filter(e => e.name.startsWith(flat(d) + '_') && !e.name.slice(flat(d).length + 1).includes('_')).map(e => ({ name: e.name.slice(flat(d).length + 1), dir: false })),
  remove: (p: string) => localBackend.remove(key(p)),
  claim: (p: string) => localBackend.claim(key(p)),
})
`,
  )
  mkdirSync(state)
  writeFileSync(join(state, 'backend.json'), JSON.stringify({ module: mod, rooms: ['hubbed'] }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: state,
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_CLAUDE: fake,
    ROOMS_AS: 'builder',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  delete env.CLAUDE_ROOMS_BACKEND
  const rooms = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })
  const ok = (...args: string[]) => {
    const r = rooms(...args)
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return r.stdout
  }
  const repo = join(base, 'repo')
  mkdirSync(repo)
  spawnSync('git', ['init', '-q', repo])
  spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], { env })
  ok('init')
  ok('new', 'hubbed', 'Hubbed', '--session', 'l2', '--repo', repo)
  ok('add', 'hubbed', 'Build it', '--cap', '1', '--acc', 'works', '--in', 'spec')
  ok('spawn', 'hubbed', 'T01', '--repo', repo)

  // the brief hands over a working copy, not a hub key
  const args = readFileSync(join(base, 'args.txt'), 'utf8')
  const m = args.match(/Your item: (\S+)/)
  assert.ok(m, args)
  const working = m![1]
  assert.ok(working.startsWith(join(state, 'scratch', 'hubbed', 'T01')), working)
  assert.ok(existsSync(working))
  assert.match(readFileSync(working, 'utf8'), /state: doing/)
  assert.match(args, /working copy/)

  // the worker edits the Result and ticks the acceptance in the copy, then reports
  writeFileSync(
    working,
    readFileSync(working, 'utf8').replace('Done:\n', 'Done: built it\n').replace('Next:', 'Next: none (nothing follows)').replace('- [ ] works', '- [x] works'),
  )
  ok('log', 'hubbed', 'T01', 'halfway')
  assert.match(readFileSync(working, 'utf8'), /halfway/) // the copy is refreshed from the hub
  assert.match(ok('done', 'hubbed', 'T01'), /T01: done/)

  const hubText = readdirSync(hub)
    .filter(f => /items_T01/.test(f))
    .map(f => readFileSync(join(hub, f), 'utf8'))
    .join('')
  assert.match(hubText, /state: done/)
  assert.match(hubText, /Done: built it/)
  assert.match(hubText, /\[x\] works/)
  assert.match(hubText, /halfway/)
  assert.equal(existsSync(join(base, 'rooms', 'hubbed', 'items')), false)
})

test('in a routed room the lead and workers edit now-head, BRIEF, notes and an item in a working tree; every command takes it to the hub', () => {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rooms-tree-'))
  const state = join(base, 'state')
  const hub = join(base, 'hub')
  mkdirSync(hub)
  const fake = join(base, 'claude')
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in agents) echo '[]'; exit 0;; esac\necho "backgrounded · abc123"\n`)
  chmodSync(fake, 0o755)
  const mod = join(base, 'hubmod.ts')
  writeFileSync(
    mod,
    `import { localBackend } from ${JSON.stringify(resolve(import.meta.dirname, '..', 'src', 'backend.ts'))}
const dir = ${JSON.stringify(hub)}
const flat = (p: string) => p.replace(/[\\\\/]/g, '_')
const key = (p: string) => dir + '/' + flat(p)
export default () => ({
  read: (p: string) => localBackend.read(key(p)),
  write: (p: string, t: string) => localBackend.write(key(p), t),
  append: (p: string, t: string) => localBackend.append(key(p), t),
  exists: (p: string) => localBackend.exists(key(p)),
  list: (d: string) => localBackend.list(dir).filter(e => e.name.startsWith(flat(d) + '_') && !e.name.slice(flat(d).length + 1).includes('_')).map(e => ({ name: e.name.slice(flat(d).length + 1), dir: false })),
  remove: (p: string) => localBackend.remove(key(p)),
  claim: (p: string) => localBackend.claim(key(p)),
})
`,
  )
  mkdirSync(state)
  writeFileSync(join(state, 'backend.json'), JSON.stringify({ module: mod, rooms: ['hubbed'] }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_ROOMS_HOME: join(base, 'rooms'),
    CLAUDE_ROOMS_STATE: state,
    CLAUDE_ROOMS_CONFIG: join(base, 'none.json'),
    CLAUDE_ROOMS_CLAUDE: fake,
    ROOMS_AS: 'builder',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  }
  delete env.CLAUDE_ROOMS_BACKEND
  const rooms = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })
  const ok = (...args: string[]) => {
    const r = rooms(...args)
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return r.stdout
  }
  const hubFile = (name: string) => join(hub, readdirSync(hub).find(f => f.endsWith(name)) ?? `missing-${name}`)
  const onHub = (name: string) => readFileSync(hubFile(name), 'utf8')
  const repo = join(base, 'repo')
  mkdirSync(repo)
  spawnSync('git', ['init', '-q', repo])
  ok('init')
  const tree = join(state, 'work', 'hubbed')
  assert.match(ok('new', 'hubbed', 'Hubbed', '--session', 'l2', '--repo', repo), new RegExp(`created ${tree}`))
  assert.match(ok('status', 'hubbed'), new RegExp(`edit BRIEF.md, now-head.md.* in ${tree}`))
  const added = ok('add', 'hubbed', 'Second', '--cap', '1', '--acc', 'works')
  const item = added.match(/T01: (\S+)/)![1]
  assert.ok(item.startsWith(join(state, 'scratch', 'hubbed', 'T01')), item)
  assert.ok(existsSync(item)) // add makes the copy it prints
  ok('set', 'hubbed', 'T01', 'owner=builder')
  assert.ok(existsSync(item))
  assert.ok(existsSync(join(tree, 'now-head.md')))

  // lead: waiting:/resume: in now-head, a BRIEF section, an item section; a worker: a note
  const edit = (f: string, from: string | RegExp, to: string) => writeFileSync(f, readFileSync(f, 'utf8').replace(from, to))
  edit(join(tree, 'now-head.md'), /waiting:.*/, 'waiting: owner reply on X')
  edit(join(tree, 'now-head.md'), /resume:.*/, 'resume: 2099-01-01T00:00Z')
  edit(join(tree, 'BRIEF.md'), /## Team\n.*/, '## Team\nbuilder: standard')
  edit(item, '- [ ] works', '- [ ] works well')
  mkdirSync(join(tree, 'notes'), { recursive: true })
  writeFileSync(join(tree, 'notes', 'builder.md'), '# notes\nhello\n')
  ok('status', 'hubbed') // any command syncs
  assert.match(onHub('rooms_hubbed_now-head.md'), /waiting: owner reply on X/)
  assert.match(onHub('rooms_hubbed_now-head.md'), /resume: 2099/)
  assert.match(onHub('rooms_hubbed_BRIEF.md'), /builder: standard/)
  assert.match(onHub('rooms_hubbed_notes_builder.md'), /hello/)
  assert.match(readdirSync(hub).filter(f => /items_T01/.test(f)).map(f => readFileSync(join(hub, f), 'utf8')).join(''), /works well/)
  assert.equal(existsSync(join(base, 'rooms', 'hubbed')), false) // the folder is never created

  // after syncIn pushed the edit, the file's base is what was pushed (a hook does syncIn only)
  assert.equal(readFileSync(join(tree, '.now-head.md.base'), 'utf8'), onHub('rooms_hubbed_now-head.md'))

  // a change on the hub meanwhile stays; the same field changed on both sides: hub wins, the edit is kept aside
  edit(hubFile('rooms_hubbed_now-head.md'), /phase:.*/, 'phase: from the hub')
  edit(join(tree, 'now-head.md'), /waiting:.*/, 'waiting: mine')
  edit(hubFile('rooms_hubbed_now-head.md'), /waiting:.*/, 'waiting: theirs')
  const r = rooms('status', 'hubbed')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /changed on the hub too/)
  assert.match(onHub('rooms_hubbed_now-head.md'), /phase: from the hub/)
  assert.match(onHub('rooms_hubbed_now-head.md'), /waiting: theirs/)
  assert.match(readFileSync(join(tree, 'now-head.md.conflict'), 'utf8'), /waiting: mine/)
  assert.match(readFileSync(join(tree, 'now-head.md'), 'utf8'), /waiting: theirs/)
})
