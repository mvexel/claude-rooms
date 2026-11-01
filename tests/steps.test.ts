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
