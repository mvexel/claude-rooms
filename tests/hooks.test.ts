import { test } from 'node:test'
import assert from 'node:assert/strict'

let instance = 0
async function harness() {
  // Each session gets fresh module state, just as the plugin runtime does.
  const { register } = await import(`../hooks/register.ts?session=${instance++}`)
  const hooks = new Map<string, Function>()
  register((name: string, ...args: any[]) => {
    hooks.set(name, args.at(-1))
    return { catch() {} }
  })
  let identity = {}
  let check = ''
  const calls: string[][] = []
  const $ = {
    env: { get: async () => 'rooms' },
    session: { id: async () => 'session-1' },
    clock: { now: async () => 100_000, every() {} },
    command: { register: async () => {} },
    ui: { status() {} },
    process: {
      run: async (args: string[]) => {
        calls.push(args)
        return { exitCode: 0, stdout: args[2] === 'prompt' ? 'Recorded D01 b' : args[2] === 'check' ? check : JSON.stringify(identity) }
      },
    },
  }
  return {
    hooks, calls,
    identify(value: object) { identity = value },
    sandbox(note: string) { check = note },
    async start() {
      await hooks.get('session.start')!($, {}, async (e: object) => e)
      await new Promise(r => setTimeout(r, 0))
    },
    async submit(event: object) {
      return hooks.get('prompt.submit')!($, event, async (e: object) => e)
    },
  }
}

test('lead role reaches submitted context without a system-prompt hook', async () => {
  const s = await harness()
  s.identify({ room: 'demo', role: 'lead' })
  assert.equal(s.hooks.has('prompt.compose'), false)
  const e = await s.submit({ text: 'Continue', context: ['existing context'] })
  assert.equal(e.text, 'Continue')
  assert.equal(e.context[0], 'existing context')
  assert.match(e.context[1], /You lead room demo.*rooms:lead/)
  assert.ok(s.calls.every(args => !args.includes('--take')))
})

test('worker gets its item and completion command, including plugin submissions', async () => {
  const s = await harness()
  s.identify({ room: 'demo', role: 'worker', item: 'T02' })
  const e = await s.submit({ text: '[rooms] Update', origin: { kind: 'plugin' } })
  assert.match(e.context[0], /rooms:worker skill; finish with rooms done demo T02/)
})

test('ordinary sessions pass through and discover a newly assigned room immediately', async () => {
  const s = await harness()
  const original = { text: 'Hello' }
  assert.deepEqual(await s.submit(original), original)
  s.identify({ room: 'new-room', role: 'lead' })
  const e = await s.submit(original)
  assert.match(e.context[0], /You lead room new-room/)
  assert.deepEqual(original, { text: 'Hello' })
})

test('owner answers are still recorded alongside role context', async () => {
  const s = await harness()
  s.identify({ room: 'demo', role: 'lead' })
  const e = await s.submit({ text: 'D01 b please' })
  assert.equal(e.text, 'D01 b please\n\nRecorded D01 b')
  assert.match(e.context[0], /rooms:lead/)
  assert.equal(s.calls.filter(args => args[2] === 'prompt').length, 1)
  await s.submit({ text: 'D01 b', origin: { kind: 'plugin' } })
  assert.equal(s.calls.filter(args => args[2] === 'prompt').length, 1)
})

test('mail for the session reaches submitted context, even outside a room', async () => {
  const s = await harness()
  s.identify({ events: '[rooms] You are no longer the lead of room demo' })
  const e = await s.submit({ text: 'Hello' })
  assert.deepEqual(e.context, ['[rooms] You are no longer the lead of room demo'])
})

test('a sandbox gap is said once, on the first prompt about rooms', async () => {
  const s = await harness()
  s.sandbox('[rooms] Note: the Bash sandbox cannot write ~/rooms')
  await s.start()
  const plain = await s.submit({ text: 'fix the build' }) as any
  assert.equal((plain.context ?? []).length, 0)
  const first = await s.submit({ text: 'open a room for the importer' }) as any
  assert.ok(first.context.some((c: string) => c.includes('sandbox cannot write')))
  const again = await s.submit({ text: 'and the rooms page?' }) as any
  assert.equal((again.context ?? []).some((c: string) => c.includes('sandbox')), false)
})
