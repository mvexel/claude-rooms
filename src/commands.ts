import { spawnSync } from 'node:child_process'
import { hallMonitor } from './monitor.ts'
import { type Dirent, appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUB_TIMEOUT_MS, backend, isRouted, loadBackend, routingActive } from './backend.ts'
import { watchdog } from './watchdog.ts'
import { applyDueDefaults, recordAnswer } from './answer.ts'
import { claudeBin, claudeDir, config, legacyStateDir, roomsHome, scratchDir, stateDir } from './config.ts'
import { autocommit, commit, excludeLocal, git, pushInBackground, unwritable, withLock } from './git.ts'
import { applyUserSandbox, planUserSandbox, sandboxGap } from './sandbox.ts'
import { beat, dispatch, emit, mailKey, render, take, tellSession, tellWorker } from './events.ts'
import { editDir, editPath, findWorkItem, publishWorking, syncIn, syncOut } from './working.ts'
import { Record, hhmm, now } from './record.ts'
import { ITEM_STATES, OPEN_ITEM, Room, by, logLine } from './room.ts'
import { currentSessionId, findSession, isEnded, isRunning, listSessions, liveness, startSession, WORKER_DISALLOWED_TOOLS } from './sessions.ts'
import { isHuman, roomState, tryRoomState } from './state.ts'
import { roomStatusLine, statusText } from './status.ts'
import { repositoryIdentity, repositoryRoot, workerWorktree } from './repositories.ts'
import { pruneCandidates, pruneRoom } from './prune.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export type Args = { _: string[]; flags: { [k: string]: string[] } }

const ALIASES: { [k: string]: string } = { o: 'option', m: 'message' }

export function parseArgs(argv: string[], booleans: Set<string>): Args {
  const a: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--') {
      a._.push(...argv.slice(i + 1))
      break
    }
    if (/^--?[a-z]/i.test(t)) {
      let key = t.replace(/^--?/, '')
      let val: string
      if (key.includes('=')) [key, val] = [key.slice(0, key.indexOf('=')), key.slice(key.indexOf('=') + 1)]
      else {
        key = ALIASES[key] ?? key
        val = booleans.has(key) ? 'true' : (argv[++i] ?? '')
      }
      ;(a.flags[ALIASES[key] ?? key] ??= []).push(val)
    } else a._.push(t)
  }
  return a
}

const BOOLEANS = new Set(['yes', 'json', 'force', 'yield', 'brief', 'feature', 'research', 'review', 'premise', 'todo', 'text', 'take', 'lead', 'keep-old', 'help'])
const flag = (a: Args, k: string) => a.flags[k]?.at(-1) ?? ''
const many = (a: Args, k: string) => a.flags[k] ?? []
const has = (a: Args, k: string) => k in a.flags
const csv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)

function fail(msg: string): never {
  throw new Error(msg)
}

// The integration branch named by the brief's code: line ("<branch> at <worktree>").
// Free text there would otherwise reach git as a base ref and fail as "invalid reference".
function codeBranch(r: Room): string | undefined {
  const code = r.brief.get('code').trim()
  if (!code) return undefined
  const m = /^(\S+) at \S/.exec(code)
  if (!m) fail(`code: line in ${r.name}'s BRIEF.md is "${code}"; expected "code: <branch> at <worktree>" (e.g. code: rooms-maint/int at /home/me/dev/claude-rooms-int)`)
  return m[1]
}

function room(name: string | undefined): Room {
  return new Room(name ?? fail('room name required')).must()
}

function refuseClosed(r: Room, what: string): void {
  if (r.isClosed()) fail(`refused: ${r.name} is closed. Don't add ${what} to a closed room; follow-up work gets its own room (rooms new <name> "<title>").`)
}

function changed(r: Room, msg: string): void {
  autocommit(`${r.name}: ${msg}`, config().commitDebounceMs)
}

// Tell the room's lead, unless the caller is the lead.
function tellLead(r: Room, text: string): string {
  if (process.env.ROOMS_TURN || (r.leadSession() && r.leadSession() === currentSessionId())) return 'you are the lead'
  emit(r.name, text)
  return 'lead told'
}

function parseDuration(s: string, fallbackMin: number): number {
  const m = s.match(/^(\d+)\s*(m|min|h)?$/)
  if (!m) return fallbackMin
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1)
}

// ---- setup -----------------------------------------------------------------

function cmdInit(): string {
  const home = roomsHome()
  mkdirSync(home, { recursive: true })
  if (!existsSync(join(home, '.git'))) {
    git(['init', '-q', '-b', 'main'], home)
    writeFileSync(join(home, 'README.md'), "# Rooms\n\nRoom records for claude-rooms: one folder per room. `rooms status <room>` shows one.\n")
    git(['add', 'README.md'], home)
    git(['commit', '-q', '-m', 'rooms: init'], home)
  }
  excludeLocal()
  return [
    `rooms home: ${home}`,
    ...moveLegacyState(),
    git(['remote'], home).out ? 'mirror: pushes go to the remote in the background' : `mirror: none (optional: git -C ${home} remote add origin <url>)`,
    `One-shot lead turns run in ${home}: open \`claude\` there once and accept the trust prompt.`,
  ].join('\n')
}

// State moved into the rooms home in 0.3. Move an older one over once.
// A process still on older code (a long-running rooms serve, say) keeps
// writing the old place; its inboxes are carried over on every command, so
// no event is stranded there while versions are mixed.
function moveLegacyState(): string[] {
  const from = legacyStateDir()
  if (process.env.CLAUDE_ROOMS_STATE || !existsSync(from)) return []
  // Legacy state belongs to the default home only; a custom CLAUDE_ROOMS_HOME is a different install.
  if (resolve(roomsHome()) !== resolve(homedir(), 'rooms')) return []
  if (existsSync(stateDir())) {
    carryLegacyInboxes(join(from, 'rooms'), join(stateDir(), 'rooms'))
    return []
  }
  try {
    mkdirSync(roomsHome(), { recursive: true })
    cpSync(from, stateDir(), { recursive: true })
    const missing = missingFiles(from, stateDir())
    if (missing) throw new Error(`copy incomplete (${missing} missing), original kept`)
    rmSync(from, { recursive: true, force: true })
    return [`state: moved ${from} to ${stateDir()}`]
  } catch (e) {
    return [`state: could not move ${from} to ${stateDir()}: ${(e as Error).message}`]
  }
}

// First file under `from` that has no same-size twin under `to`, or ''.
function missingFiles(from: string, to: string): string {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name)
    const dst = join(to, e.name)
    if (e.isDirectory()) {
      if (!existsSync(dst)) return dst
      const m = missingFiles(src, dst)
      if (m) return m
    } else if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) return dst
  }
  return ''
}

// Rename first, so an append from the old writer lands in a new file, not a lost one.
function carryLegacyInboxes(from: string, to: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(from, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const src = join(from, e.name)
    if (e.isDirectory()) carryLegacyInboxes(src, join(to, e.name))
    else if (e.name === 'inbox.jsonl') {
      try {
        const moving = `${src}.${process.pid}.moving`
        renameSync(src, moving)
        const text = readFileSync(moving, 'utf8')
        if (text.trim()) {
          mkdirSync(to, { recursive: true })
          appendFileSync(join(to, 'inbox.jsonl'), text.endsWith('\n') ? text : text + '\n')
        }
        rmSync(moving)
      } catch {}
    }
  }
}

function cmdInstall(a: Args): string {
  const bin = join(homedir(), '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const target = join(bin, 'rooms')
  if (existsSync(target)) unlinkSync(target)
  symlinkSync(join(ROOT, 'cli', 'rooms.ts'), target)
  return [`linked ${target} -> ${join(ROOT, 'cli', 'rooms.ts')}`, installSandbox(a)].join('\n')
}

// The user's own settings change, so the user says yes to it: at the prompt,
// or with --yes. Without a terminal and without --yes, only say what to add.
function installSandbox(a: Args): string {
  const plan = planUserSandbox()
  if (plan.error) return `sandbox: ${plan.error}`
  if (plan.already) return `sandbox: ${plan.file} already lets sandboxed sessions write ${plan.entry}`
  const ask = `Sandboxed Claude Code sessions can't write ${plan.entry}, where rooms keeps its records and state.\nAdd "${plan.entry}" to sandbox.filesystem.allowWrite in ${plan.file}? [y/N] `
  let yes = has(a, 'yes')
  if (!yes) {
    if (!process.stdin.isTTY) return `sandbox: not changed. To let sandboxed sessions use rooms, add "${plan.entry}" to sandbox.filesystem.allowWrite in ${plan.file}, or run \`rooms install\` in a terminal.`
    process.stdout.write(ask)
    yes = /^y(es)?$/i.test(readLine())
  }
  if (!yes) return `sandbox: not changed. Rooms commands will fail in sandboxed sessions until "${plan.entry}" is in sandbox.filesystem.allowWrite.`
  try {
    return `sandbox: ${applyUserSandbox()}`
  } catch (e) {
    return `sandbox: could not update ${plan.file} (${(e as Error).message}). Run \`rooms install\` in a terminal, outside Claude Code.`
  }
}

function readLine(): string {
  const buf = Buffer.alloc(256)
  let s = ''
  for (;;) {
    let n = 0
    try {
      n = readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue
      return s
    }
    if (n === 0) return s
    s += buf.toString('utf8', 0, n)
    if (s.includes('\n')) return s.slice(0, s.indexOf('\n')).trim()
  }
}

// ---- rooms and records -----------------------------------------------------

// Records may refer to a repo on a disk that is not currently mounted.
function identityOf(repo: string): string {
  try {
    return repositoryIdentity(repo)
  } catch {
    return resolve(repo)
  }
}

// The open room for the repository at path: at most one, by the rule above.
function roomForRepo(path: string): Room | undefined {
  const id = identityOf(path)
  return Room.all().find(r => !r.isClosed() && r.brief.list('repos').some(repo => identityOf(repo) === id))
}

function cmdNew(a: Args): string {
  return withLock('room-create', () => createRoom(a))
}

function createRoom(a: Args): string {
  const [name, title] = a._
  if (!name || !title) fail('usage: rooms new <room> "<Title>" [--repo <path>] [--feature] [--session <lead session id>]')
  const r = new Room(name)
  if (r.exists()) fail(`room ${name} exists`)
  const lead = flag(a, 'session') || currentSessionId() || ''
  const repos = [...new Set((many(a, 'repo').length ? many(a, 'repo') : [process.cwd()]).map(repositoryRoot))]
  const identities = new Set(repos.map(repositoryIdentity))
  const open = Room.all().filter(x => !x.isClosed())
  for (const other of open) {
    const repo = other.brief.list('repos').find(repo => identities.has(identityOf(repo)))
    if (repo) fail(`refused: ${other.name} is still open for repo ${repo} on this machine. Only one room per repo may be open; finish and close it before starting another.`)
  }
  const otherLead = lead && open.find(x => x.leadSession() === lead)
  if (otherLead) fail(`refused: this session already leads ${otherLead.name}. One session leads one room; start a new session for a new room.`)
  // items/, decisions/ and notes/ appear with their first file
  const brief = new Record(join(r.dir, 'BRIEF.md'), '---\n---\n')
  for (const [k, v] of [
    ['title', title],
    ['repos', repos],
    ['lead_session', lead],
    ['sessions', '[]'],
    ['code', ''],
    ['closed', ''],
    ['paused', ''],
  ])
    brief.set(k, v)
  brief.preamble = `# ${title}\n\n`
  brief.setSection('Goal', 'What we are trying to learn or ship, in two lines.')
  brief.setSection('Premises', 'One line each, pointing at a P record.')
  brief.setSection('Scope', 'In:\nOut:')
  brief.setSection('Team', 'One line per member: role, model tier, charter (what it owns and what it does not).')
  brief.setSection('Where things are', 'Integration branch and worktree, repos, scratch.')
  brief.save()
  const head = new Record(join(r.dir, 'now-head.md'), '---\n---\n')
  for (const [k, v] of [
    ['phase', has(a, 'feature') ? 'PRD: lead drafting; building locked' : 'starting'],
    ['since', now()],
    ['updated', now()],
    ['waiting', ''],
    ['resume', ''],
  ])
    head.set(k, v)
  head.save()
  if (has(a, 'feature')) backend().write(join(r.dir, 'PRD.md'), readFileSync(join(ROOT, 'templates', 'prd.md'), 'utf8').replace('{title}', title).replace('{now}', now()))
  changed(r, 'new room')
  return [
    `created ${editDir(r)}${lead ? ` · lead session ${lead}` : ' · no lead session: events run one-shot lead turns until one claims it (rooms lead)'}`,
    has(a, 'feature') ? `PRD.md drafted from the template. Building is locked until the owner agrees it (rooms prd ${name} review); research items (rooms add --research) may run before.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function cmdAdd(a: Args): string {
  const [name, title] = a._
  const r = room(name)
  refuseClosed(r, 'an item')
  if (!title) fail('usage: rooms add <room> "<title>" --acc "..." --in "..." [--dep T01] [--cap 2] [--owner role] [--research]')
  const research = has(a, 'research')
  const cap = flag(a, 'cap')
  if (research) {
    if (Number(cap || 0) > 4) fail('a research item is capped at 4h; split it, or it is build work')
    const live = r.items().filter(i => i.get('kind') === 'research' && OPEN_ITEM.has(i.get('state'))).length
    if (r.buildLocked() && live >= 3) fail('three research items are already open before the PRD is agreed; finish one, or agree the PRD')
  }
  const id = r.nextId('T')
  const fields: [string, string | string[]][] = [
    ['state', 'todo'],
    ['owner', flag(a, 'owner')],
    ['depends_on', csv(flag(a, 'dep'))],
    ['locks', csv(flag(a, 'locks'))],
  ]
  if (research) fields.push(['kind', 'research'])
  fields.push(['cap_h', cap], ['tier', flag(a, 'tier')], ['agent', ''], ['updated', now()])
  const rec = r.create('items', id, title, fields, [
    ['Acceptance', many(a, 'acc').map(l => `- [ ] ${l}`).join('\n') || '- [ ] '],
    ['Inputs', many(a, 'in').map(l => `- ${l}`).join('\n') || '- '],
    ['Log', `- ${hhmm()} ${by()}: created`],
    ['Result', 'Done:\nArtifacts:\nUnverified:\nNext:'],
  ])
  changed(r, `${id} added`)
  // A routed room's item is on the hub: the lead edits a working copy, so make it (the path printed exists).
  return `${id}: ${publishWorking(r, rec)}`
}

// Who gets a card: the owner sees one-way doors, premises, gates, todos and
// free-text asks. A reversible call goes ahead by default unless stopped; a
// call for a role on the team never reaches the page.
function cmdAsk(a: Args): string {
  const [name, title] = a._
  const r = room(name)
  refuseClosed(r, 'a card')
  if (!title) fail('usage: rooms ask <room> "<Question?>" -o "..." -o "..." [--door one|two --default b] [--premise|--todo --steps "..."|--text] [--blocks T03]')
  const decider = flag(a, 'decider') || 'human'
  let type = 'decision'
  if (has(a, 'premise')) type = 'premise'
  if (has(a, 'todo')) type = 'todo'
  if (has(a, 'text')) type = 'ask'
  let opts = many(a, 'option')
  let door = flag(a, 'door') || (type === 'decision' ? 'two' : 'one')
  let status = 'open'
  let def = ''
  let due = ''
  if (type === 'todo') {
    if (!flag(a, 'steps')) fail('a todo card needs --steps: exactly what the owner does, commands included (never a secret)')
    if (!opts.length) opts = ['Done, I did this', "Can't do this yet (say why in the note)"]
  }
  if (type === 'premise' && !opts.length) opts = ["Yes, that's right", 'No, change it (say how in the note)']
  if (type === 'decision' && opts.length < 2) fail('a decision needs at least two -o options')
  if (opts.length > 5) fail('five options at most; reasoning goes in --why')
  if (opts.some(o => o.length > 80)) fail('keep each option under 80 characters; detail goes in --why')
  if (type === 'decision' && isHuman(decider) && door === 'two') {
    def = flag(a, 'default') || fail('a reversible call goes ahead by default: give --default <letter> (and --due 90m), or --door one if it is hard to undo')
    if (!opts[def.charCodeAt(0) - 97]) fail(`--default ${def} is not an option`)
    const mins = Math.max(30, parseDuration(flag(a, 'due'), config().provisionalMinutes))
    due = new Date(Date.now() + mins * 60_000).toISOString().slice(0, 16) + 'Z'
    status = 'provisional'
  }
  const pick = flag(a, 'pick')
  if (pick && !opts[pick.charCodeAt(0) - 97]) fail(`--pick ${pick} is not an option`)
  const prefix = type === 'premise' ? 'P' : type === 'ask' || type === 'todo' ? 'A' : 'D'
  const id = r.nextId(prefix)
  const sections: [string, string][] = []
  if (opts.length) sections.push(['Options', opts.map((t, i) => `${String.fromCharCode(97 + i)}) ${t}`).join('\n')])
  if (flag(a, 'steps')) sections.push(['Steps', flag(a, 'steps')])
  sections.push(['Why it matters', flag(a, 'why')], ['Answer', ''])
  const rec = r.create('decisions', id, title, [
    ['type', type],
    ['door', door],
    ['decider', decider],
    ['status', status],
    ['default', def],
    ['due', due],
    ['pick', pick],
    ['pick_reason', flag(a, 'pick-reason')],
    ['source', flag(a, 'source')],
    ['blocks', csv(flag(a, 'blocks'))],
    ['urgent', flag(a, 'urgent')],
    ['supersedes', flag(a, 'supersedes')],
    ['opened', now()],
    ['updated', now()],
  ], sections)
  changed(r, `${id} asked`)
  const where = !isHuman(decider) ? `team decision for ${decider} (not on the page)` : status === 'provisional' ? `goes ahead with ${def} at ${due} unless the owner stops it` : 'on the owner\'s page'
  return `${id}: ${where} · ${editPath(r, rec.path)}`
}

function briefGaps(it: Record): string[] {
  return [
    /^\s*[-*]\s*\[[ xX]\]\s*\S/m.test(it.section('Acceptance')) ? '' : 'Acceptance',
    /^\s*(?:[-*]\s*)?[^\s\-*]/m.test(it.section('Inputs')) ? '' : 'Inputs',
  ].filter(Boolean)
}

// The guards on starting work, shared by set and spawn.
function guardStart(r: Room, it: Record, force: boolean): string[] {
  const warns: string[] = []
  if (force) return warns
  if (r.isPaused()) fail(`${r.name} is paused: don't start new work`)
  if (r.buildLocked() && it.get('kind') !== 'research') fail(`${r.name}: the PRD is ${r.prd()!.get('status')}. Only research items start before the owner agrees it (rooms prd ${r.name} review)`)
  const gaps = briefGaps(it)
  if (gaps.length) fail(`refused: ${it.get('id')} has an empty ${gaps.join(' and ')}. Write the brief first (edit the item), or --force`)
  if (!it.get('cap_h')) warns.push(`warn: ${it.get('id')} has no cap_h`)
  return warns
}

function cmdSet(a: Args): string {
  const [name, id, ...pairs] = a._
  const r = room(name)
  const rec = id === 'PRD' ? (r.prd() ?? fail('no PRD.md')) : findWorkItem(r, id ?? fail('id required'))
  const kv = pairs.map(p => {
    const i = p.indexOf('=')
    if (i < 1) fail(`not key=value: ${p}`)
    return [p.slice(0, i), p.slice(i + 1)] as [string, string]
  })
  const state = kv.find(p => p[0] === 'state')?.[1]
  if (id.startsWith('RF') && rec.get('status') === 'agreed' && !(kv.length === 1 && kv[0][0] === 'status' && kv[0][1] === 'superseded')) fail(`${id} is agreed and never edited; write a new refinement`)
  if (id === 'PRD' && rec.get('status') === 'agreed') fail('an agreed PRD is never edited; write a refinement (rooms rf)')
  if (state && id.startsWith('T') && !(ITEM_STATES as readonly string[]).includes(state)) fail(`state must be one of ${ITEM_STATES.join(', ')}`)
  const warns = state === 'doing' && rec.get('state') !== 'doing' ? guardStart(r, rec, has(a, 'force')) : []
  for (const [k, v] of kv) rec.set(k, v.startsWith('[') ? csv(v.replace(/^\[|\]$/g, '')) : v)
  if (rec.sections.some(s => s[0] === 'Log')) logLine(rec, by(), `set ${pairs.join(' ')}`)
  else rec.set('updated', now())
  rec.save()
  if (id.startsWith('T')) publishWorking(r, rec)
  changed(r, `${id} ${pairs.join(' ')}`)
  return [...warns, `${id}: ${pairs.join(' ')}`].join('\n')
}

function cmdLog(a: Args): string {
  const [name, id, text] = a._
  const r = room(name)
  const rec = findWorkItem(r, id ?? fail('id required'))
  logLine(rec, by(), text || fail('text required'))
  rec.save()
  if (id.startsWith('T')) publishWorking(r, rec)
  changed(r, `${id} log`)
  return `${id}: logged`
}

function cmdNeed(a: Args): string {
  const [name, id, raw] = a._
  const r = room(name)
  refuseClosed(r, 'a need')
  if (!id?.startsWith('T')) fail('a need is on an item (Tnn)')
  const it = findWorkItem(r, id)
  if (!['doing', 'todo'].includes(it.get('state'))) fail(`${id} is ${it.get('state')}`)
  const text = (raw ?? '').replace(/\s+/g, ' ').trim() || fail('say what is missing and why')
  const needs = flag(a, 'needs')
  if (needs) r.find(needs)
  const tail = needs ? ` (needs ${needs})` : ''
  it.set('state', 'blocked')
  it.appendTo('Needs', `- ${hhmm()} ${by()}: ${text}${tail}`)
  logLine(it, by(), `need: ${text}${tail}; state=blocked`)
  it.save()
  publishWorking(r, it)
  changed(r, `${id} blocked`)
  const told = tellLead(r, `${id} (${it.get('title')}) is blocked by ${by()}: ${text}${tail}. Decide now: an existing item first (depends_on), a small new prerequisite inside the PRD, or a scope change (refinement or card). Then flip it back and tell the worker.`)
  return `${id} blocked; ${told}. Stop here and end your turn with this need as your report.`
}

function cmdDone(a: Args): string {
  const [name, id] = a._
  const r = room(name)
  if (!id?.startsWith('T')) fail('usage: rooms done <room> <Tnn> [--review]')
  const it = findWorkItem(r, id)
  const res = it.section('Result')
  const field = (k: string) => (res.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))?.[1] ?? '').trim()
  if (!field('Done')) fail(`${id}: write the Result first (Done:, Artifacts:, Unverified:, Next:)`)
  const next = field('Next')
  if (!/\b(?:[TDAP]\d{2,}|PRD)\b|^(?:none|nothing)\b/i.test(next)) fail(`${id}: Next: must name the record that carries the work on (T/D/A id), or say "none (why)"`)
  const unchecked = (it.section('Acceptance').match(/^\s*[-*]\s*\[ \]/gm) ?? []).length
  const state = has(a, 'review') ? 'review' : 'done'
  if (state === 'done' && unchecked && !has(a, 'force')) fail(`${id}: ${unchecked} acceptance line(s) unchecked; tick them, use --review, or --force`)
  it.set('state', state)
  logLine(it, by(), `set state=${state}`)
  it.save()
  // Scratch is kept for review (--review); only a finished item sheds it.
  if (state === 'done') {
    const scratch = scratchDir(r.name, id)
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true })
  }
  changed(r, `${id} ${state}`)
  const told = tellLead(r, `${id} (${it.get('title')}) is ${state}, by ${by()}. Next: ${next}. Read its Result and take the next step.`)
  return `${id}: ${state}; ${told}`
}

function cmdAnswer(a: Args): string {
  const [name, id, choice] = a._
  const r = room(name)
  const d = r.find(id ?? fail('id required'))
  const reply = flag(a, 'reply')
  if (reply) {
    d.appendTo('Questions', `- A · ${by()} · ${hhmm().slice(0, 5)}: "${reply.replace(/\s+/g, ' ').replace(/"/g, "'")}"`)
    d.set('updated', now())
    d.save()
    changed(r, `reply on ${id}`)
    return `${id}: replied (the card stays open)`
  }
  if (!choice) fail('usage: rooms answer <room> <id> <letter|note> [--note ...] [--quote "owner\'s words"] | --reply "text"')
  if (d.get('status') === 'final') fail(`${id} is already answered`)
  if (d.get('status') === 'withdrawn') fail(`${id} was withdrawn; nothing to answer`)
  return recordAnswer(r, id, { choice, by: flag(a, 'by') || 'human', quote: flag(a, 'quote'), note: flag(a, 'note') })
}

// Withdraw an open card the lead no longer needs: it leaves the page and Needs
// you, and the record stays with the reason.
function cmdWithdraw(a: Args): string {
  const [name, id, ...rest] = a._
  const r = room(name)
  if (!id || !/^[DAP]\d/.test(id)) fail('usage: rooms withdraw <room> <Dnn|An|Pn> "<reason>"')
  const d = r.find(id)
  const reason = rest.join(' ').replace(/\s+/g, ' ').trim() || fail('say why the card is withdrawn')
  if (!['open', 'provisional'].includes(d.get('status'))) fail(`${id} is ${d.get('status')}; only an open card can be withdrawn`)
  d.set('status', 'withdrawn')
  d.set('withdrawn', now())
  d.set('updated', now())
  d.appendTo('Withdrawn', `- ${hhmm()} ${by()}: ${reason}`)
  if (d.sections.some(s => s[0] === 'Log')) logLine(d, by(), `withdrawn: ${reason}`)
  d.save()
  changed(r, `${id} withdrawn`)
  const blocked = d.list('blocks')
  return `${id}: withdrawn (${reason})${blocked.length ? `. It still lists ${blocked.join(', ')} in blocks; decide those items yourself` : ''}`
}

function cmdPrd(a: Args): string {
  const [name, verb] = a._
  const r = room(name)
  if (verb !== 'review') fail('usage: rooms prd <room> review')
  const prd = r.prd() ?? fail(`${name} has no PRD.md (rooms new --feature makes one)`)
  if (prd.get('status') === 'agreed') fail('the PRD is already agreed; changes are refinements (rooms rf)')
  const lines = (backend().read(prd.path) ?? '').split('\n').length
  if (lines > 130) fail(`PRD.md is ${lines} lines; the limit is 120. Move approach and research to notes/`)
  if (!/^Lead:[ \t]*\S/m.test(prd.section('Sign-off'))) fail('sign the PRD first: a "Lead: <name>, <date>" line in Sign-off')
  const open = prd.section('Open questions').split('\n').filter(l => /^\s*([-*]|\d+\.)\s+\S/.test(l) && !/[TDAP]\d{2,}/.test(l))
  if (open.length) fail(`open questions without an owner record: ${open.length}. Give each a D/A card or a bounded T, or delete it`)
  if (r.decisions().some(d => d.get('type') === 'prd' && d.get('status') === 'open')) fail('an Agree PRD card is already open')
  prd.set('status', 'review')
  prd.set('updated', now())
  prd.save()
  const blocks = r.items().filter(i => OPEN_ITEM.has(i.get('state')) && i.get('kind') !== 'research').map(i => i.get('id'))
  const id = r.nextId('D')
  r.create('decisions', id, `Agree the PRD for ${r.brief.get('title')}?`, [
    ['type', 'prd'],
    ['door', 'one'],
    ['decider', 'human'],
    ['status', 'open'],
    ['source', '"PRD.md"'],
    ['blocks', blocks],
    ['opened', now()],
    ['updated', now()],
  ], [
    ['Options', 'a) Agreed: start building\nb) Changes needed (say what in the note)'],
    ['Why it matters', 'Building is locked until this is agreed. Read the PRD first.'],
    ['Answer', ''],
  ])
  changed(r, `${id} agree PRD`)
  return `${id}: Agree PRD is on the owner's page`
}

function cmdRf(a: Args): string {
  const [name, verb, arg] = a._
  const r = room(name)
  if (!r.prd()) fail('refinements change an agreed PRD; this room has none')
  if (verb === 'new') {
    refuseClosed(r, 'a refinement')
    const touches = csv(flag(a, 'touches'))
    if (!touches.length) fail('--touches is required: a change that names no requirement is a pivot (a new room)')
    const supersedes = csv(flag(a, 'supersedes'))
    for (const s of supersedes) r.find(s)
    const id = r.nextId('RF')
    const rec = r.create('refinements', id, arg || fail('title required'), [
      ['status', 'draft'],
      ['touches', touches],
      ['supersedes', supersedes],
      ['agreed', ''],
      ['updated', now()],
    ], [
      ['Trigger', "What happened: the evidence, or the owner's quoted words."],
      ['Change', 'For each touched id: was: <exact text>; now: <exact text>.'],
      ['Why this stays inside the PRD', 'Purpose, stakeholders, goals and non-goals, definition of done: unchanged, one line each.'],
      ['Effect on work', 'Items to create, change or drop (ids).'],
      ['Sign-off', 'Lead:\nOwner:'],
    ])
    changed(r, `${id} drafted`)
    return `${id}: ${editPath(r, rec.path)}`
  }
  if (/^RF\d+$/.test(verb ?? '') && arg === 'review') {
    const rf = r.find(verb)
    if (!['draft', 'review'].includes(rf.get('status'))) fail(`${verb} is ${rf.get('status')}`)
    if (!/^Lead:[ \t]*\S/m.test(rf.section('Sign-off'))) fail(`sign ${verb} first: a "Lead:" line in Sign-off`)
    if (r.decisions().some(d => d.get('type') === 'refinement' && d.get('status') === 'open' && d.get('source').replace(/"/g, '') === verb)) fail(`a card for ${verb} is already open`)
    // The owner already asked for it in chat: --quote records that as the agreement.
    const quote = flag(a, 'quote')
    rf.set('status', 'review')
    rf.save()
    const re = new RegExp(`\\b${verb}\\b`)
    const blocks = r.items().filter(i => OPEN_ITEM.has(i.get('state')) && re.test(i.toString())).map(i => i.get('id'))
    const id = r.nextId('D')
    r.create('decisions', id, `Agree ${verb}: ${rf.get('title')}?`, [
      ['type', 'refinement'],
      ['door', 'two'],
      ['decider', 'human'],
      ['status', 'open'],
      ['source', `"${verb}"`],
      ['blocks', blocks],
      ['opened', now()],
      ['updated', now()],
    ], [
      ['Options', 'a) Agreed: this is now binding\nb) Changes needed (say what in the note)'],
      ['Why it matters', ''],
      ['Answer', ''],
    ])
    if (quote) return recordAnswer(r, id, { choice: 'a', by: 'human', source: 'asked for in chat', quote })
    changed(r, `${id} agree ${verb}`)
    return `${id}: Agree ${verb} is on the owner's page`
  }
  fail('usage: rooms rf <room> new "<title>" --touches FR4 [--supersedes RF01] | rooms rf <room> RFnn review [--quote "owner\'s words"]')
}

function cmdBinding(r: Room): string {
  if (!r.prd()) return ''
  const rfs = r.refinements().filter(x => x.get('status') === 'agreed')
  return [`BINDING: PRD.md${rfs.length ? ' + ' + rfs.map(x => x.get('id')).join(', ') : ''} (later refinements win)`, backend().read(join(r.dir, 'PRD.md')) ?? '', ...rfs.map(x => x.toString())].join('\n\n')
}

function cmdClose(a: Args): string {
  const [name, reason] = a._
  return closeRoom(room(name), reason || fail('give a one-line reason'), has(a, 'force'))
}

// Forced, the open items stay as they are and the reason names them.
export function closeRoom(r: Room, reason: string, force = false): string {
  const open = r.items().filter(i => OPEN_ITEM.has(i.get('state'))).map(i => i.get('id'))
  if (open.length && !force) fail(`${r.name} has open items: ${open.join(' ')}. Finish or drop them first, or --force`)
  const b = r.brief
  b.set('closed', `${now()} ${reason}${open.length ? ` (left open: ${open.join(' ')})` : ''}`)
  b.save()
  commit(r.name, `${r.name}: closed`)
  pushInBackground()
  const left = pruneCandidates(r).filter(e => e.remove).length
  return `${r.name} closed${left ? `\n${left} worktree/branch of finished items can go: rooms prune ${r.name} --yes` : ''}`
}

function cmdPrune(a: Args): string {
  return pruneRoom(room(a._[0]), has(a, 'yes'))
}

export function setTitle(r: Room, title: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t) fail('give a title')
  const b = r.brief
  if (b.get('title') === t) return `${r.name} already titled ${t}`
  b.set('title', t)
  b.save()
  changed(r, `title: ${t}`)
  return `${r.name} titled ${t}`
}

export function setPaused(r: Room, on: boolean): string {
  const b = r.brief
  if (!!b.get('paused') === on) return `${r.name} already ${on ? 'paused' : 'running'}`
  b.set('paused', on ? now() : '')
  b.save()
  changed(r, on ? 'paused' : 'resumed')
  emit(
    r.name,
    on
      ? `The owner PAUSED room ${r.name}. Spawn nothing; tell each running worker (rooms tell) to finish its current step, write its Log and Result, and stop.`
      : `The owner RESUMED room ${r.name}. Re-read the room (rooms status ${r.name}) and dispatch every ready item.`,
  )
  return `${r.name} ${on ? 'paused' : 'resumed'}`
}

// ---- views -----------------------------------------------------------------

// A routed room that can't be read counts as open: the overview lists it as unreachable.
function closedOrUnknown(r: Room): boolean {
  try {
    return r.isClosed()
  } catch (e) {
    if (isRouted(r.name)) return false
    throw e
  }
}

function cmdStatus(a: Args): { text: string; code: number } {
  const sessions = listSessions()
  const rooms = a._.length ? a._.map(n => room(n)) : Room.all().filter(r => !closedOrUnknown(r))
  if (!rooms.length) return { text: `no rooms in ${roomsHome()}`, code: 0 }
  // With rooms named, a failure is the answer; in the overview, a room on the
  // hub that cannot be read is listed as unreachable and the rest still show.
  const states = rooms.map(r => (a._.length ? { st: roomState(r, { sessions, yielding: has(a, 'yield') }) } : tryRoomState(r, { sessions, yielding: has(a, 'yield') })))
  if (has(a, 'json')) return { text: JSON.stringify(rooms.map((r, i) => ('st' in states[i] ? { room: r.name, ...pick(states[i].st) } : { room: r.name, unreachable: true, error: states[i].error }))), code: 0 }
  let stuck = false
  const out = rooms.map((r, i) => {
    const s = states[i]
    if (!('st' in s)) return `${r.name} · UNREACHABLE: ${s.error}`
    const st = s.st
    if (has(a, 'yield') && st.status === 'stuck') stuck = true
    let t = statusText(r, st, has(a, 'brief'))
    const hm = hallMonitor(r, sessions)
    if (hm.clones.length) t += `\n  hall monitor: too many items wait on one role; clone for ${hm.clones.map(c => `${c.item} (${c.name})`).join(', ')} (${hm.running}/${hm.max} threads; rooms spawn names the clone)`
    if (hm.queued.length) t += `\n  hall monitor: ${hm.queued.join(' ')} wait for a free thread (${hm.running}/${hm.max})`
    if (has(a, 'yield') && st.dispatchable.length) t += `\n  ${st.dispatchable.join(' ')} ready with no agent: dispatch before you end your turn`
    if (has(a, 'yield') && st.status === 'stuck') t += `\n  STUCK if you stop now: dispatch the next item, put a real question to the owner, set waiting:/resume: in now-head.md, or close the room.`
    return t
  })
  return { text: out.join('\n\n'), code: stuck ? 1 : 0 }
}

function pick(st: ReturnType<typeof roomState>) {
  return { status: st.status, sentence: st.sentence, line: st.line, cards: st.needsYou.map(d => d.get('id')), moving: st.moving, ready: st.ready, warnings: st.warnings }
}

function whoami(session: string): { room?: string; role?: string; item?: string; session: string } {
  for (const r of Room.all()) {
    if (r.isClosed()) continue
    if (r.leadSession() === session) return { room: r.name, role: 'lead', session }
    const it = r.items().find(i => i.get('agent') === session && OPEN_ITEM.has(i.get('state')))
    if (it) return { room: r.name, role: it.get('owner') || 'worker', item: it.get('id'), session }
  }
  return { session }
}

function sessionArg(a: Args): string {
  return flag(a, 'session') || currentSessionId() || ''
}

// ---- sessions --------------------------------------------------------------

function cmdSpawn(a: Args): string {
  const [name, id] = a._
  const r = room(name)
  refuseClosed(r, 'a worker')
  const c = config()
  if (has(a, 'lead')) {
    const prompt = `You are the lead of room ${r.name}. Load the rooms:lead skill, then run: rooms status ${r.name}`
    const s = startSession({ prompt, cwd: roomsHome(), name: `lead · ${r.name}`, model: c.lead.model, permissionMode: c.lead.permissionMode })
    const b = r.brief
    b.set('lead_session', s.sessionId)
    b.save()
    changed(r, 'lead session started')
    return `${r.name}: lead session ${s.id} started`
  }
  const it = findWorkItem(r, id ?? fail('usage: rooms spawn <room> <Tnn> [--tier light|standard|review] [--repo <path> [--base <branch>]] | --lead'))
  if (it.get('agent')) {
    const sessions = listSessions()
    const s = findSession(it.get('agent'), sessions)
    if (isRunning(s ?? it.get('agent'), sessions)) fail(`${id} already has a live worker (${s?.id ?? it.get('agent')}); send it a message with rooms tell instead`)
    if (!isEnded(s ?? it.get('agent'), sessions) && !has(a, 'force')) fail(`${id}'s worker session ${it.get('agent')} may be alive (liveness unknown: sandboxed or session list unavailable); run from outside the sandbox, or --force once you know it ended`)
  }
  const warns = guardStart(r, it, has(a, 'force'))
  const tierName = flag(a, 'tier') || it.get('tier') || c.worker.tier
  const tier = c.tiers[tierName] ?? fail(`unknown tier ${tierName} (config tiers: ${Object.keys(c.tiers).join(', ')})`)
  const model = flag(a, 'model') || tier.model
  const effort = flag(a, 'effort') || tier.effort
  // The repo is --repo, else the room's first repo from BRIEF.md; never the lead's cwd.
  const repo = flag(a, 'repo') || r.brief.list('repos')[0]
  let cwd = repo ?? process.cwd()
  // One worktree per agent: the item's own branch off the integration branch.
  // Research items read; they get no worktree.
  if (it.get('kind') !== 'research') {
    if (!repo) fail(`${id}: ${r.name} has no repo in BRIEF.md; pass --repo <path> (a worker never starts outside its own worktree)`)
    const base = flag(a, 'base') || codeBranch(r) || 'HEAD'
    const wt = workerWorktree(repo, r.name, id)
    cwd = wt.path
    const branch = wt.branch
    if (!existsSync(cwd)) {
      const w = spawnSync('git', ['-C', repo, 'worktree', 'add', cwd, '-b', branch, base], { encoding: 'utf8' })
      if (w.status !== 0) fail(`git worktree add failed: ${w.stderr.trim()}`)
    }
    it.appendTo('Inputs', `- Worktree: ${cwd} (branch ${branch} from ${base})`)
  }
  const scratch = scratchDir(r.name, id)
  try {
    mkdirSync(scratch, { recursive: true })
  } catch (e) {
    fail(unwritable(scratch, e as Error))
  }
  const plan = hallMonitor(r)
  if (plan.running >= plan.max && !has(a, 'force')) fail(`${r.name} already runs ${plan.running} workers (hallMonitor.maxThreads ${plan.max}); wait for one to finish, raise maxThreads in the config, or --force`)
  const who = flag(a, 'name') || plan.clones.find(c => c.item === id)?.name || it.get('owner') || 'worker'
  // A routed room's item is on the hub; the worker edits a working copy that the commands sync.
  const itemFile = publishWorking(r, it)
  const prompt = [
    `You are ${who} on item ${id} (${it.get('title')}) in room ${r.name}. Load the rooms:worker skill first.`,
    `Your item: ${itemFile}`,
    itemFile === it.path ? '' : `(${r.name} is on the hub: this is a working copy. Edit it freely; rooms log, set, need and done take your edits to the hub.)`,
    r.prd() ? `Binding set: rooms brief ${r.name}` : '',
    `Scratch: ${scratch} (export TMPDIR=${scratch}; never /tmp). Cap: ${it.get('cap_h') || '?'}h.`,
    `Use ROOMS_AS=${who} for rooms commands. Finish with: write the Result in the item, then rooms done ${r.name} ${id} (or --review). Unplanned work you need: rooms need ${r.name} ${id} "<what and why>", then stop.`,
    flag(a, 'brief'),
  ]
    .filter(Boolean)
    .join('\n')
  const s = startSession({ prompt, cwd, name: `${who} · ${id}`, model, effort, permissionMode: flag(a, 'permission-mode') || c.worker.permissionMode, disallowedTools: WORKER_DISALLOWED_TOOLS })
  it.set('state', 'doing')
  it.set('agent', s.sessionId)
  logLine(it, by(), `set state=doing; spawned ${who} (session ${s.id}) in ${cwd}; model: ${model ?? 'default'}, effort: ${effort ?? 'default'}`)
  it.save()
  publishWorking(r, it)
  changed(r, `${id} spawned`)
  return [...warns, `${id}: ${who} started (session ${s.id}, ${model ?? 'default model'})`].join('\n')
}

// Make a session the room's lead. Without a room, the room is the open one
// for the repository at the current directory, never another repo's. A lead
// that is replaced is told to hand off and stop.
function cmdLead(a: Args): string {
  const r = a._[0]
    ? room(a._[0])
    : (roomForRepo(process.cwd()) ??
      fail(`no open room for the repository at ${process.cwd()}. Open rooms: ${Room.all().filter(x => !x.isClosed()).map(x => `${x.name} (${x.brief.list('repos').join(', ')})`).join('; ') || 'none'}. Name one (rooms lead <room>) only if the owner asked for it; otherwise start one with rooms new.`))
  const session = a._[1] || currentSessionId() || fail('no session id given and none found for this process')
  const other = Room.all().find(x => x.name !== r.name && x.leadSession() === session && !x.isClosed())
  if (other) fail(`refused: session ${session} already leads ${other.name}`)
  if (r.isClosed()) fail(`refused: ${r.name} is closed; follow-up work gets its own room (rooms new)`)
  const b = r.brief
  const old = b.get('lead_session')
  if (old === session) return `${session} already leads ${r.name}`
  b.set('lead_session', session)
  b.set('sessions', [...b.list('sessions').filter(s => s !== session && s !== old), ...(old && has(a, 'keep-old') ? [old] : [])])
  b.save()
  changed(r, `lead is ${session}`)
  if (session !== currentSessionId()) emit(r.name, `You are now the lead of room ${r.name}. Load the rooms:lead skill and run rooms status ${r.name}.`)
  const out = [`${r.name}: lead ${old || '-'} -> ${session}`]
  if (old) out.push(`previous lead ${old}: ${tellSession(old, handoffNote(r, session))}`)
  // A fresh lead starts from the record. When the old lead's transcript isn't
  // on this host (the room moved), it can't be resumed; say so and show the head.
  if (old && !hasTranscript(old)) out.push(`previous lead's transcript is not on this host; starting fresh from the record, not resuming it`)
  const head = r.head.toString().trim()
  out.push(`now-head:\n${head || '(empty)'}`)
  return out.join('\n')
}

function hasTranscript(session: string): boolean {
  const base = join(claudeDir(), 'projects')
  try {
    return readdirSync(base).some(d => existsSync(join(base, d, `${session}.jsonl`)))
  } catch {
    return false
  }
}

function handoffNote(r: Room, next: string): string {
  return [
    `You are no longer the lead of room ${r.name}: session ${next} took it over at ${now()}.`,
    `Hand off: send anything the record doesn't hold yet to the new lead with rooms tell ${r.name} "handoff: ...". Don't dispatch, answer or change the room's records any more.`,
    `Then tell the owner in one line that you handed off and that this session can be closed, and end your turn.`,
  ].join(' ')
}

// Open the room's lead to talk to it: attach if it runs in the background,
// resume it here if it has ended.
function cmdChat(a: Args): string {
  const r = room(a._[0])
  const lead = r.leadSession()
  if (!lead) fail(`${r.name} has no lead session; start one with rooms spawn ${r.name} --lead, or run rooms lead ${r.name} from a session`)
  const sessions = listSessions()
  const s = findSession(lead, sessions)
  const live = liveness(lead, sessions)
  if (live !== 'alive' && !hasTranscript(lead)) fail(`lead session ${lead} has no transcript on this host, so it can't be resumed; run rooms lead ${r.name} from a fresh session to take over from the record`)
  if (live === 'unknown') fail(`lead session ${lead} liveness unknown (sandboxed?); not resuming, which could fork it`)
  const args = live === 'alive' && s ? ['attach', s.id] : ['--resume', lead]
  spawnSync(claudeBin(), args, { cwd: roomsHome(), stdio: 'inherit' })
  return ''
}

function cmdTell(a: Args): string {
  const [name, text] = a._
  const r = room(name)
  if (!text) fail('usage: rooms tell <room> "<message>" [--item Tnn]')
  const item = flag(a, 'item')
  if (item) {
    // A message to a worker: logged on the item, delivered to its session.
    const it = r.find(item)
    logLine(it, by(), `message: ${text}`)
    it.save()
    changed(r, `message to ${item}`)
    if (!it.get('agent')) return `${item}: logged (no worker session)`
    return `${item}: ${tellWorker(r, item, it.get('agent'), `From ${by()}: ${text}`)}`
  }
  emit(r.name, `From ${by()}: ${text}`)
  return `${r.name}: lead told (${dispatch(r.name).why || 'queued'})`
}

// The page server runs this every few seconds; a systemd timer can too.
export function sweep(): string[] {
  const out: string[] = []
  for (const r of Room.all()) {
    try {
      const applied = applyDueDefaults(r)
      if (applied.length) out.push(`${r.name}: went ahead ${applied.join(' ')}`)
      const d = dispatch(r.name)
      if (d.route !== 'empty') out.push(`${r.name}: ${d.route} (${d.why})`)
    } catch (e) {
      out.push(`${r.name}: ${(e as Error).message}`)
    }
  }
  const c = commit(undefined, `rooms: update at ${now()}`)
  if (c.sha) pushInBackground()
  return out
}

// ---- plugin plumbing --------------------------------------------------------

function cmdHook(a: Args): string {
  const [verb] = a._
  // Once per session: can its Bash sandbox write the rooms home?
  if (verb === 'check') {
    const gap = sandboxGap()
    return gap ? `[rooms] Note: ${gap}. Tell the owner to run \`rooms install\` in a terminal (it asks before adding the path to their sandbox settings), then restart this session.` : ''
  }
  const session = sessionArg(a) || fail('--session required')
  const me = whoami(session)
  // A routed lead's edits to the working tree go to the hub (no hub call when nothing changed).
  let syncNote = ''
  if ((verb === 'poll' || verb === 'stop') && me.role === 'lead' && me.room && isRouted(me.room)) {
    try {
      const lr = new Room(me.room)
      if (lr.exists()) {
        const w = syncIn(lr)
        if (w.length) syncNote = `[rooms] Your edits to the working tree were not all taken in: ${w.join('; ')}`
      }
    } catch (e) {
      syncNote = `[rooms] Could not take your working-tree edits to the hub: ${(e as Error).message}`
    }
  }
  if (verb === 'stop' && syncNote && me.role === 'lead') return syncNote
  if (verb === 'poll') {
    // Hold the lease on this session's inbox (the room's for the lead, the
    // item's for a worker), and take what waits when asked to.
    // Mail to the session itself (a handoff) is always taken: it may be the
    // only thing a session that just lost its room still hears.
    const mail = render(`session ${session}`, take(mailKey(session)))
    if (!me.room) return JSON.stringify(mail ? { ...me, events: mail } : me)
    const key = me.role === 'lead' ? me.room : `${me.room}/${me.item}`
    beat(key, session)
    const text = [syncNote, mail, has(a, 'take') ? render(key, take(key)) : ''].filter(Boolean).join('\n\n')
    return JSON.stringify({ ...me, events: text, status_line: roomStatusLine(new Room(me.room)) })
  }
  if (verb === 'stop') {
    // A worker's turn ended. If its item is still doing, it stopped without reporting.
    if (!me.room || !me.item) return ''
    const r = new Room(me.room)
    const it = r.find(me.item)
    if (it.get('state') !== 'doing') return ''
    emit(r.name, `${me.item} (${it.get('title')}): the worker's turn ended with the item still doing and no rooms done. Read its Log; tell it what is missing (rooms tell ${r.name} "..." --item ${me.item}) or re-plan.`)
    return 'lead told'
  }
  if (verb === 'prompt') {
    // The owner typed "D05 b" to the lead: record it before the lead reads it.
    if (me.role !== 'lead' || !me.room) return ''
    const r = new Room(me.room)
    const text = flag(a, 'said')
    const done: string[] = []
    for (const m of text.matchAll(/\b([DAP]\d{2,})\s+([a-e])\b/g)) {
      try {
        const d = r.find(m[1])
        if (d.get('status') !== 'open' && d.get('status') !== 'provisional') continue
        if (!isHuman(d.get('decider'))) continue
        recordAnswer(r, m[1], { choice: m[2], by: 'human', source: 'in chat', quote: text.slice(0, 200) })
        done.push(`${m[1]} ${m[2]}`)
      } catch {}
    }
    return done.length ? `[rooms] Recorded from the owner's message: ${done.join(', ')} (already on the cards; do not record them again).` : ''
  }
  fail('usage: rooms hook poll|stop|prompt|check --session S')
}

// ---- dispatch --------------------------------------------------------------

export const HELP = `rooms: agent team rooms for Claude Code. Records: ${'$'}CLAUDE_ROOMS_HOME (default ~/rooms)

Lead
  rooms new <room> "<Title>" [--repo <path>] [--feature]  one open room per repo on this machine; repo defaults to cwd
  rooms add <room> "<title>" --acc "..." --in "..." [--dep T01,T02] [--cap 2] [--owner role] [--tier light|standard|review] [--research]
  rooms ask <room> "<Question?>" -o "..." -o "..." [--pick b --pick-reason "..."] [--blocks T03] [--why "..."]
        [--door one]                                 hard to undo: a card for the owner
        [--default b --due 90m]                      reversible: goes ahead unless the owner stops it
        [--premise | --todo --steps "..." | --text]  premise, a task for the owner, a free-text question
        [--decider <role>]                           a team decision, never on the page
  rooms spawn <room> <Tnn> [--tier T] [--repo <path> [--base <branch>]] [--name N] [--brief "..."]
  rooms spawn <room> --lead                         start a background lead session for the room
  rooms answer <room> <id> <letter|note> [--quote "owner's words"] [--note "..."] | --reply "text"
  rooms withdraw <room> <Dnn|An> "<reason>"          take an open card off the page; the record keeps the reason
  rooms prd <room> review | rooms rf <room> new "<title>" --touches FR4 | rooms rf <room> RFnn review [--quote ...]
  rooms status [room] [--yield] [--brief] [--json]   exit 1 with --yield when stopping now would leave it stuck
  rooms statusline [room]                         compact status; accepts Claude status-line JSON on stdin
  rooms brief <room>                                 the binding set: PRD + agreed refinements
  rooms set <room> <id> key=value... [--force] | pause|resume <room> | close <room> "reason"
  rooms prune <room> [--yes]                         list worktrees/branches of done or dropped items; --yes removes the merged ones
  rooms lead [<room> [session]]                      make this session the lead; no room: the open room for this repo.
                                                     The previous lead is told to hand off.
  rooms tell <room> "msg" [--item Tnn]               message the lead (or a worker, via its item Log)
  rooms chat <room>                                  open the room's lead session here

Worker
  rooms log <room> <Tnn> "text" | rooms need <room> <Tnn> "what is missing and why" | rooms done <room> <Tnn> [--review]

Setup and plumbing
  rooms init | install [--yes] | serve [--port 8787] [--host 127.0.0.1] | sweep | whoami | hook poll|stop|prompt|check

Set ROOMS_AS=<name> so Log lines carry it.`

// Commands whose first argument is a room.
const ROOM_FIRST = new Set(['new', 'add', 'ask', 'spawn', 'set', 'withdraw', 'log', 'need', 'done', 'answer', 'prd', 'rf', 'brief', 'status', 'pause', 'resume', 'close', 'prune', 'tell', 'lead', 'chat'])

// In a routed room, take the working tree's edits to the hub before the command
// and refresh the tree after it.
export async function run(argv: string[]): Promise<{ text: string; code: number }> {
  await loadBackend()
  const name = ROOM_FIRST.has(argv[0] ?? '') && /^[a-z0-9][a-z0-9-]*$/.test(argv[1] ?? '') ? argv[1] : undefined
  if (!name || !isRouted(name)) return runCommand(argv)
  const r = new Room(name)
  if (argv[0] !== 'new' && r.exists()) syncIn(r)
  try {
    return await runCommand(argv)
  } finally {
    try {
      if (r.exists()) syncOut(r)
    } catch (e) {
      process.stderr.write(`rooms: working copy of ${name} not refreshed: ${(e as Error).message}\n`)
    }
  }
}

async function runCommand(argv: string[]): Promise<{ text: string; code: number }> {
  if (argv[0] === 'hook' && routingActive()) watchdog(HUB_TIMEOUT_MS + 4000, 'the hook')
  const a = parseArgs(argv, BOOLEANS)
  const cmd = a._.shift() ?? 'help'
  if (cmd !== 'init') moveLegacyState()
  const ok = (text: string) => ({ text, code: 0 })
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return ok(HELP)
    case 'init':
      return ok(cmdInit())
    case 'install':
      return ok(cmdInstall(a))
    case 'new':
      return ok(cmdNew(a))
    case 'add':
      return ok(cmdAdd(a))
    case 'ask':
      return ok(cmdAsk(a))
    case 'spawn':
      return ok(cmdSpawn(a))
    case 'set':
      return ok(cmdSet(a))
    case 'withdraw':
      return ok(cmdWithdraw(a))
    case 'log':
      return ok(cmdLog(a))
    case 'need':
      return ok(cmdNeed(a))
    case 'done':
      return ok(cmdDone(a))
    case 'answer':
      return ok(cmdAnswer(a))
    case 'prd':
      return ok(cmdPrd(a))
    case 'rf':
      return ok(cmdRf(a))
    case 'brief':
    {
      const r = room(a._[0])
      const text = cmdBinding(r) || `${a._[0]} has no PRD`
      return ok(isRouted(r.name) ? `${text}\n\n(on the hub: working copy of the room's files in ${editDir(r)})` : text)
    }
    case 'statusline': {
      if (a._[0]) return ok(roomStatusLine(room(a._[0])))
      let session = flag(a, 'session')
      if (!session && !process.stdin.isTTY) {
        let input = ''
        for await (const chunk of process.stdin) input += chunk
        try { session = JSON.parse(input).session_id || ''; } catch { return ok(''); }
      }
      const me = whoami(session || currentSessionId() || '')
      return ok(me.room ? roomStatusLine(new Room(me.room)) : '')
    }
    case 'status':
      return cmdStatus(a)
    case 'pause':
      return ok(setPaused(room(a._[0]), true))
    case 'resume':
      return ok(setPaused(room(a._[0]), false))
    case 'close':
      return ok(cmdClose(a))
    case 'prune':
      return ok(cmdPrune(a))
    case 'lead':
      return ok(cmdLead(a))
    case 'chat':
      return ok(cmdChat(a))
    case 'tell':
      return ok(cmdTell(a))
    case 'sweep':
      return ok(sweep().join('\n'))
    case 'whoami': {
      const me = whoami(sessionArg(a) || fail('no Claude Code session found for this process'))
      return ok(has(a, 'json') ? JSON.stringify(me) : me.room ? `${me.role} in ${me.room}${me.item ? ` (${me.item})` : ''}` : 'not in a room')
    }
    case 'hook':
      return ok(cmdHook(a))
    case 'serve': {
      const { serve } = await import('./server.ts')
      await serve({ port: Number(flag(a, 'port') || 8787), host: flag(a, 'host') || '127.0.0.1' })
      return ok('')
    }
    default:
      fail(`unknown command ${cmd}; see rooms help`)
  }
}

export { basename }
