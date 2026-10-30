import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Record } from '../src/record.ts'
import { Room } from '../src/room.ts'
import { roomState } from '../src/state.ts'
import { roomDetail } from '../src/server.ts'

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

test('an unwritable state dir fails rooms new at once, not after the lock deadline', () => {
  const s = sandbox()
  const state = s.env.CLAUDE_ROOMS_STATE
  mkdirSync(join(state, 'locks'), { recursive: true })
  chmodSync(join(state, 'locks'), 0o500)
  try {
    const started = Date.now()
    const r = s.rooms('new', 'r', 'Room', '--repo', s.home)
    assert.notEqual(r.code, 0)
    assert.match(r.err, /cannot write .*\(EACCES\).*\/sandbox/)
    assert.ok(Date.now() - started < 10_000, 'took the lock deadline')
  } finally {
    chmodSync(join(state, 'locks'), 0o700)
  }
})

test('install adds the rooms home to the sandbox only on yes; hook check warns until then; state stays out of git', () => {
  const s = sandbox()
  const base = resolve(s.home, '..')
  const env: { [k: string]: string | undefined } = { ...s.env, HOME: base, CLAUDE_CONFIG_DIR: join(base, '.claude'), CLAUDE_ROOMS_HOME: join(base, 'rooms') }
  delete env.CLAUDE_ROOMS_STATE
  const rooms = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env, cwd: join(base, 'proj'), encoding: 'utf8', input: '' })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  const settings = join(base, '.claude', 'settings.json')
  mkdirSync(join(base, '.claude'))
  mkdirSync(join(base, 'proj'))
  writeFileSync(settings, JSON.stringify({ model: 'opus', sandbox: { enabled: true, filesystem: { allowWrite: ['/opt/x'] } } }, null, 4) + '\n')

  assert.match(rooms('hook', 'check').out, /sandbox can't write ~\/rooms.*rooms install/)
  // No terminal and no --yes: the user's settings are left alone.
  assert.match(rooms('install').out, /sandbox: not changed/)
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).sandbox.filesystem.allowWrite, ['/opt/x'])

  assert.match(rooms('install', '--yes').out, /added "~\/rooms"/)
  const after = readFileSync(settings, 'utf8')
  assert.deepEqual(JSON.parse(after), { model: 'opus', sandbox: { enabled: true, filesystem: { allowWrite: ['/opt/x', '~/rooms'] } } })
  assert.match(after, /^ {4}"model"/m)
  assert.ok(readFileSync(settings + '.bak', 'utf8').includes('"/opt/x"'))
  assert.match(rooms('install', '--yes').out, /already lets/)
  assert.equal(rooms('hook', 'check').out, '')

  assert.equal(rooms('init').code, 0)
  assert.equal(rooms('new', 'r', 'Room', '--repo', base).code, 0, 'new')
  assert.ok(existsSync(join(base, 'rooms', '.state', 'locks')))
  const tracked = spawnSync('git', ['ls-files'], { cwd: join(base, 'rooms'), encoding: 'utf8' }).stdout
  const untracked = spawnSync('git', ['status', '--porcelain'], { cwd: join(base, 'rooms'), encoding: 'utf8' }).stdout
  assert.doesNotMatch(tracked + untracked, /\.state/)
})

test('events an older process left in the old state dir are carried into the new one', () => {
  const s = sandbox()
  const base = resolve(s.home, '..')
  const env: { [k: string]: string | undefined } = { ...s.env, HOME: base }
  delete env.CLAUDE_ROOMS_STATE
  const old = join(base, '.local', 'state', 'claude-rooms', 'rooms', 'r')
  mkdirSync(old, { recursive: true })
  mkdirSync(join(s.home, '.state', 'rooms', 'r'), { recursive: true })
  writeFileSync(join(s.home, '.state', 'rooms', 'r', 'inbox.jsonl'), '{"id":"a","text":"new"}\n')
  writeFileSync(join(old, 'inbox.jsonl'), '{"id":"b","text":"stranded"}\n')
  spawnSync(process.execPath, ['--no-warnings', CLI, 'help'], { env, encoding: 'utf8' })
  assert.equal(readFileSync(join(s.home, '.state', 'rooms', 'r', 'inbox.jsonl'), 'utf8'), '{"id":"a","text":"new"}\n{"id":"b","text":"stranded"}\n')
  assert.equal(existsSync(join(old, 'inbox.jsonl')), false)
})

test("a worker's scratch folder lives in the state dir, inside the rooms home", () => {
  const s = sandbox()
  s.ok('new', 'r', 'Room', '--repo', s.home)
  s.ok('add', 'r', 'Build', '--cap', '1', '--acc', 'works', '--in', 'spec')
  const r = s.rooms('spawn', 'r', 'T01')
  assert.match(r.err, /claude --bg failed/)
  assert.ok(existsSync(join(s.env.CLAUDE_ROOMS_STATE, 'scratch', 'r', 'T01')))
})

test('one open room per repo per machine; other repos are allowed and paused rooms retain their repo', () => {
  const s = sandbox()
  s.ok('new', 'first', 'First')
  const rejected = s.rooms('new', 'second', 'Second', '--session', 'another-lead')
  assert.notEqual(rejected.code, 0)
  assert.match(rejected.err, /first is still open for repo.*Only one room per repo/)
  const otherRepo = join(s.home, 'other-project')
  mkdirSync(otherRepo)
  s.ok('new', 'other', 'Other', '--repo', otherRepo, '--session', 'other-lead')
  s.ok('pause', 'first')
  assert.notEqual(s.rooms('new', 'second', 'Second', '--session', 'another-lead').code, 0)
  s.ok('close', 'first', 'Finished')
  s.ok('new', 'second', 'Second', '--session', 'another-lead')
})

test('simultaneous room creation for the same repo admits exactly one room', async () => {
  const s = sandbox()
  const start = (name: string) => new Promise<number | null>((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', CLI, 'new', name, name, '--session', name], { env: s.env, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', resolve)
  })
  const codes = await Promise.all([start('first'), start('second')])
  assert.equal(codes.filter(c => c === 0).length, 1)
  assert.equal(JSON.parse(s.ok('status', '--json')).length, 1)
})

test('repo scope recognizes subdirectories, symlinks and Git worktrees', () => {
  const s = sandbox()
  const repo = join(s.home, 'project'), sub = join(repo, 'sub'), alias = join(s.home, 'alias'), worktree = join(s.home, 'worktree')
  mkdirSync(sub, { recursive: true })
  const git = (...args: string[]) => {
    const p = spawnSync('git', ['-C', repo, ...args], { env: s.env, encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
  }
  git('init', '-q')
  git('commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'Initial')
  git('worktree', 'add', '-q', worktree, '-b', 'worker')
  symlinkSync(repo, alias)
  s.ok('new', 'first', 'First', '--repo', sub)
  for (const path of [repo, alias, worktree]) {
    assert.match(s.rooms('new', 'second', 'Second', '--repo', path, '--session', 'other').err, /Only one room per repo/)
  }
  const brief = Record.load(join(s.home, 'first', 'BRIEF.md'))
  assert.deepEqual(brief.list('repos'), [realpathSync(repo)])
})

test('prose answers and notes on owner tasks retain the supplied observations', () => {
  const s = sandbox()
  s.ok('new', 'ride', 'Ride')
  s.ok('ask', 'ride', 'What did you see on the ride?', '--text')
  s.ok('answer', 'ride', 'A01', 'note', '--note', 'The crossing was muddy, but the bridge was clear.')
  assert.match(readFileSync(s.file('ride', 'decisions', 'A01'), 'utf8'), /note: "The crossing was muddy, but the bridge was clear\."/)
  s.ok('ask', 'ride', 'Ride the loop', '--todo', '--steps', 'Ride and report observations')
  s.ok('answer', 'ride', 'A02', 'a', '--note', 'Rode it; the north gate was locked.')
  assert.match(readFileSync(s.file('ride', 'decisions', 'A02'), 'utf8'), /note: "Rode it; the north gate was locked\."/)
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


test('room plan includes completed dependencies and summaries; team keeps idle members', () => {
  const s = sandbox();
  s.ok('new', 'r', 'R');
  s.ok('add', 'r', 'Schema', '--owner', 'architect', '--acc', 'Schema documented', '--in', 'brief');
  s.ok('set', 'r', 'T01', 'state=done');
  s.ok('add', 'r', 'Build', '--owner', 'builder', '--dep', 'T01', '--acc', 'Build works', '--in', 'schema');
  s.ok('add', 'r', 'Verify', '--dep', 'T02', '--acc', 'Checks pass', '--in', 'build');
  s.ok('add', 'r', 'Old approach', '--acc', 'Obsolete', '--in', 'brief');
  s.ok('set', 'r', 'T04', 'state=dropped');
  const file = s.file('r', 'items', 'T02'), record = Record.load(file);
  record.setSection('Summary', 'Build the API.\nKeep it small.'); record.save();
  const previous = process.env.CLAUDE_ROOMS_HOME;
  process.env.CLAUDE_ROOMS_HOME = s.home;
  try {
    const room = new Room('r'), detail = roomDetail(room, roomState(room, { sessions: [] }), []);
    assert.equal(detail.plan.items.length, 4);
    assert.equal(detail.plan.items[0].state, 'done');
    assert.equal(detail.plan.items[0].summary, 'Schema documented');
    assert.deepEqual(detail.plan.items[1].after, ['T01']);
    assert.equal(detail.plan.items[1].summary, 'Build the API. Keep it small.');
    assert.equal(detail.plan.items[3].state, 'dropped');
    assert.equal(detail.team.find(m => m.name === 'architect')?.items.length, 0);
    assert.equal(detail.team.find(m => m.name === 'builder')?.items[0].title, 'Build');
    assert.equal(detail.team.find(m => m.name === 'Unassigned')?.items[0].id, 'T03');
    assert.equal(detail.team_roster, undefined);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ROOMS_HOME;
    else process.env.CLAUDE_ROOMS_HOME = previous;
  }
});

test('status bar follows the session, dependencies, owner blocks and pause', () => {
  const s = sandbox();
  s.ok('new', 'r', 'R');
  s.ok('add', 'r', 'Build', '--acc', 'Works', '--in', 'brief');
  s.ok('add', 'r', 'Verify', '--dep', 'T01', '--acc', 'Passes', '--in', 'build');
  assert.match(s.ok('statusline', 'r'), /0 moving · 1 waiting · next: T01 Build/);
  assert.match(JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1')).status_line, /next: T01 Build/);
  s.ok('ask', 'r', 'Approve?', '-o', 'Yes', '-o', 'No', '--door', 'one', '--blocks', 'T01');
  assert.match(s.ok('statusline', 'r'), /2 waiting · 1 need you · next: none ready/);
  s.ok('answer', 'r', 'D01', 'a', '--quote', 'D01 a');
  s.ok('set', 'r', 'T01', 'state=doing');
  assert.match(s.ok('statusline', 'r'), /1 moving · 1 waiting/);
  s.ok('pause', 'r');
  assert.match(s.ok('statusline', 'r'), /paused$/);
  const result = spawnSync(process.execPath, ['--no-warnings', CLI, 'statusline'], {
    env: s.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'lead-session-1' }),
  });
  assert.match(result.stdout, /r · 1 moving · 1 waiting · paused/);
  const outside = spawnSync(process.execPath, ['--no-warnings', CLI, 'statusline'], {
    env: s.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'unrelated' }),
  });
  assert.equal(outside.stdout, '');
});

test("lead without a room takes this repo's room, never another's, and the old lead is told to hand off", () => {
  const s = sandbox()
  const repo = (name: string) => {
    const dir = join(s.home, '..', name)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    spawnSync('git', ['init', '-q', dir])
    return dir
  }
  const mine = repo('mine')
  s.ok('new', 'other', 'Other', '--repo', repo('theirs'), '--session', 'other-lead')
  s.ok('new', 'r', 'R', '--repo', mine)
  const lead = (cwd: string) => {
    const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'lead'], { cwd, env: { ...s.env, CLAUDE_ROOMS_SESSION: 'new-lead' }, encoding: 'utf8' })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  const elsewhere = lead(repo('unrelated'))
  assert.notEqual(elsewhere.code, 0)
  assert.match(elsewhere.err, /no open room for the repository.*other \(.*r \(/)
  const took = lead(join(mine, 'sub'))
  assert.equal(took.code, 0, took.err)
  assert.match(took.out, /r: lead lead-session-1 -> new-lead\nprevious lead lead-session-1: told to hand off/)
  assert.equal(s.ok('whoami', '--session', 'new-lead'), 'lead in r')
  assert.equal(s.ok('whoami', '--session', 'other-lead'), 'lead in other')
  const old = JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1'))
  assert.equal(old.room, undefined)
  assert.match(old.events, /no longer the lead of room r: session new-lead took it over.*rooms tell r "handoff/)
  assert.equal(JSON.parse(s.ok('hook', 'poll', '--session', 'lead-session-1')).events, undefined)
  assert.match(lead(mine).out, /new-lead already leads r/)
})

test('the session id Claude Code gives its tools identifies the session', () => {
  const s = sandbox()
  s.ok('new', 'r', 'R')
  const env = { ...s.env, CLAUDE_ROOMS_SESSION: '', CLAUDE_CODE_SESSION_ID: 'lead-session-1' }
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'whoami'], { env, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'lead in r', r.stderr)
})

function gitRepo(s: ReturnType<typeof sandbox>, dir: string) {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => {
    const p = spawnSync('git', ['-C', dir, ...args], { env: s.env, encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
    return p.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'Initial')
  return git
}

test('worker worktrees are named from the main repo root, and research items get none', () => {
  const s = sandbox()
  const repo = join(s.home, 'proj')
  const git = gitRepo(s, repo)
  const integration = join(s.home, 'proj-int')
  git('worktree', 'add', '-q', integration, '-b', 'int')
  s.ok('new', 'r', 'Room', '--repo', repo)
  s.ok('add', 'r', 'Build', '--cap', '1', '--acc', 'works', '--in', 'spec')
  s.ok('add', 'r', 'Look', '--cap', '1', '--acc', 'known', '--in', 'spec', '--research')
  s.rooms('spawn', 'r', 'T01', '--repo', integration, '--base', 'main')
  s.rooms('spawn', 'r', 'T02', '--repo', integration, '--base', 'main')
  const real = realpathSync(repo)
  assert.ok(existsSync(`${real}-r-t01`))
  assert.equal(existsSync(`${integration}-r-t01`), false)
  assert.equal(existsSync(`${real}-r-t02`), false)
})

test('prune lists done items\' worktrees and removes only merged, clean ones', () => {
  const s = sandbox()
  const repo = join(s.home, 'proj')
  const git = gitRepo(s, repo)
  s.ok('new', 'r', 'Room', '--repo', repo)
  for (const t of ['A', 'B', 'C', 'D']) s.ok('add', 'r', t, '--cap', '1', '--acc', 'x', '--in', 'y')
  const real = realpathSync(repo)
  for (const id of ['t01', 't02', 't03']) git('worktree', 'add', '-q', `${real}-r-${id}`, '-b', `rooms/r/${id}`, 'main')
  // t02 has an unmerged commit; t03 is merged but dirty; t01 has none; T04 stays open
  spawnSync('git', ['-C', `${real}-r-t02`, 'commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'work'], { env: s.env })
  writeFileSync(join(`${real}-r-t03`, 'scratch.txt'), 'x')
  git('branch', 'rooms/r/t04', 'main')
  for (const id of ['T01', 'T02', 'T03']) s.ok('set', 'r', id, 'state=done', '--force')
  const dry = s.ok('prune', 'r')
  assert.match(dry, /remove T01 rooms\/r\/t01/)
  assert.match(dry, /keep   T02.*not merged/)
  assert.match(dry, /keep   T03.*uncommitted/)
  assert.doesNotMatch(dry, /T04/)
  assert.ok(existsSync(`${real}-r-t01`))
  s.ok('prune', 'r', '--yes')
  assert.equal(existsSync(`${real}-r-t01`), false)
  assert.ok(existsSync(`${real}-r-t02`))
  assert.equal(git('branch', '--list', 'rooms/r/t01'), '')
  assert.notEqual(git('branch', '--list', 'rooms/r/t04'), '')
})

test('prune removes a branch merged into the integration branch only, not the checkout HEAD', () => {
  const s = sandbox()
  const repo = join(s.home, 'proj')
  const git = gitRepo(s, repo)
  git('branch', 'int', 'main')
  s.ok('new', 'r', 'Room', '--repo', repo)
  const brief = Record.load(join(s.home, 'r', 'BRIEF.md'))
  brief.set('code', 'int')
  brief.save()
  s.ok('add', 'r', 'A', '--cap', '1', '--acc', 'x', '--in', 'y')
  const real = realpathSync(repo)
  git('worktree', 'add', '-q', `${real}-r-t01`, '-b', 'rooms/r/t01', 'int')
  const wt = (...args: string[]) => assert.equal(spawnSync('git', ['-C', `${real}-r-t01`, ...args], { env: s.env }).status, 0)
  wt('commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'work')
  // fast-forward int to the branch without touching main's HEAD
  git('branch', '-f', 'int', 'rooms/r/t01')
  s.ok('set', 'r', 'T01', 'state=done', '--force')
  assert.match(s.ok('prune', 'r'), /remove T01.*merged into int/)
  s.ok('prune', 'r', '--yes')
  assert.equal(existsSync(`${real}-r-t01`), false)
  assert.equal(git('branch', '--list', 'rooms/r/t01'), '')
})
