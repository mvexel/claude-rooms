import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepParts } from '../src/steps.ts'

const cmds = (t: string) => stepParts(t).filter(p => p.kind === 'cmd').map(p => p.text)

test('issue #40 card splits into prose and one block per command', () => {
  const t = 'On this Mac: scp /Users/m/T16/host-x1.token x1:~/.rooms-hub-token && ssh x1 chmod 600 ~/.rooms-hub-token && rm /Users/m/T16/host-x1.token. On x1, in a checkout of mvexel/rooms-hosted at main (git pull), Node 24, outside any Claude sandbox: ROOMS_HUB_URL=https://rooms.osm.lol ROOMS_HUB_TOKEN=$(cat ~/.rooms-hub-token) RUNNER_STATE=~/.rooms-runner nohup node src/runner/main.ts >> ~/rooms-runner.log 2>&1 & — then tap Done; I check that x1 shows online on the hub.'
  const parts = stepParts(t)
  assert.deepEqual(cmds(t), [
    'scp /Users/m/T16/host-x1.token x1:~/.rooms-hub-token && ssh x1 chmod 600 ~/.rooms-hub-token && rm /Users/m/T16/host-x1.token',
    'ROOMS_HUB_URL=https://rooms.osm.lol ROOMS_HUB_TOKEN=$(cat ~/.rooms-hub-token) RUNNER_STATE=~/.rooms-runner nohup node src/runner/main.ts >> ~/rooms-runner.log 2>&1 &',
  ])
  assert.match(parts[0].text, /^On this Mac:/)
  assert.ok(parts.some(p => p.kind === 'prose' && /then tap Done/.test(p.text)))
})

test('backticks and fences are always commands', () => {
  assert.deepEqual(cmds('Run `npm test` then `git push`'), ['npm test', 'git push'])
  assert.deepEqual(cmds('Do:\n```sh\nls\ncd x\n```'), ['ls', 'cd x'])
})

test('plain prose stays prose', () => {
  assert.deepEqual(stepParts('Ride the loop and report'), [{ kind: 'prose', text: 'Ride the loop and report' }])
})

test('F1: backticked identifiers stay inline in the sentence', () => {
  const p = stepParts('Edit `config.json` and set `port` to 9000')
  assert.deepEqual(p.filter(x => x.kind === 'cmd'), [])
  assert.deepEqual(p.filter(x => x.kind === 'code').map(x => x.text), ['config.json', 'port'])
})

test('F2: English prose after a colon is not a command', () => {
  assert.deepEqual(cmds('Before you go: make sure the Mac is awake'), [])
  assert.deepEqual(cmds('Note: open the hub page and log in'), [])
  assert.deepEqual(cmds('Run: export A=1'), ['export A=1'])
})

test('F3: copied command is exactly what was written', () => {
  assert.deepEqual(cmds('In the repo: cp ~/x .'), ['cp ~/x .'])
  assert.deepEqual(cmds('Step: git commit -m "Fix it. Then push" — then wait'), ['git commit -m "Fix it. Then push"'])
  assert.deepEqual(cmds('Go: cd src/.'), ['cd src/'])
})

test('F4: a && / ; chain stays one block', () => {
  assert.deepEqual(cmds('Run: npm test; npm run build'), ['npm test; npm run build'])
})

test('F5: backslash continuation stays one block', () => {
  assert.deepEqual(cmds('Do:\n```sh\nexport A=1 \\\nB=2\nls\n```'), ['export A=1 \\\nB=2', 'ls'])
})
