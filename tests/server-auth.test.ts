import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowed } from '../src/server.ts'

const users = ['a@example.com']

test('direct loopback request without Tailscale headers is allowed when ROOMS_USERS is set', () => {
  assert.equal(isAllowed({ headers: {}, remoteAddress: '127.0.0.1' }, users), true)
  assert.equal(isAllowed({ headers: {}, remoteAddress: '::1' }, users), true)
})

test('proxied requests (funnel/serve) need a listed login', () => {
  assert.equal(isAllowed({ headers: { 'x-forwarded-for': '1.2.3.4' }, remoteAddress: '127.0.0.1' }, users), false)
  assert.equal(isAllowed({ headers: { 'tailscale-user-name': 'x' }, remoteAddress: '127.0.0.1' }, users), false)
  assert.equal(isAllowed({ headers: { 'tailscale-user-login': 'b@example.com' }, remoteAddress: '127.0.0.1' }, users), false)
  assert.equal(isAllowed({ headers: { 'tailscale-user-login': 'a@example.com' }, remoteAddress: '127.0.0.1' }, users), true)
})

test('non-loopback peer without login is refused; readonly refuses all', () => {
  assert.equal(isAllowed({ headers: {}, remoteAddress: '100.64.0.2' }, users), false)
  assert.equal(isAllowed({ headers: {}, remoteAddress: '127.0.0.1' }, users, true), false)
})

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crossSite, notAllowedMessage } from '../src/server.ts'

test('ROOMS_TRUST_LOOPBACK=0 turns loopback trust off', () => {
  const direct = { headers: {}, remoteAddress: '127.0.0.1' }
  assert.equal(isAllowed(direct, users, false, false), false)
  assert.equal(isAllowed(direct, [], false, false), false)
  assert.equal(isAllowed(direct, [], false, true), true)
  assert.equal(isAllowed({ headers: { 'tailscale-user-login': 'a@example.com' }, remoteAddress: '127.0.0.1' }, users, false, false), true)
})

test('crossSite compares Origin to Host; no Origin is fine', () => {
  assert.equal(crossSite({ host: '127.0.0.1:8787' }), false)
  assert.equal(crossSite({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }), false)
  assert.equal(crossSite({ host: '127.0.0.1:8787', origin: 'http://evil.example' }), true)
  assert.equal(crossSite({ host: '127.0.0.1:8787', origin: 'null' }), true)
})

test('403 message names the host as asked, no bogus port', () => {
  assert.match(notAllowedMessage('127.0.0.1:9123'), /at http:\/\/127\.0\.0\.1:9123$/)
  assert.doesNotMatch(notAllowedMessage('myhost'), /:\d/)
})

async function freePort(): Promise<number> {
  return new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
}

async function withServer(env: Record<string, string>, fn: (base: string) => Promise<void>) {
  const port = await freePort()
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'rooms-srv-'))
  const child = spawn(process.execPath, ['--no-warnings', '-e', `import('./src/server.ts').then(m => m.serve({ port: ${port}, host: '127.0.0.1' }))`], { env: { ...process.env, CLAUDE_ROOMS_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise<void>(r => child.stdout!.on('data', () => r()))
    await fn(`http://127.0.0.1:${port}`)
  } finally { child.kill() }
}

test('server: cross-origin text/plain POST refused, same-origin and no-Origin pass the gate', async () => {
  await withServer({ ROOMS_USERS: 'a@example.com' }, async base => {
    const url = `${base}/api/cards/x/T1/answer`
    const post = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers, body: '{}' })
    assert.equal((await post({ 'content-type': 'text/plain', origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ 'content-type': 'text/plain' })).status, 415)
    // past the gates: reaches the handler (no such room => 400)
    assert.equal((await post({ 'content-type': 'application/json', origin: base })).status, 400)
    assert.equal((await post({ 'content-type': 'application/json' })).status, 400)
  })
})

test('server: ROOMS_TRUST_LOOPBACK=0 refuses loopback POST with a message naming the URL', async () => {
  await withServer({ ROOMS_USERS: 'a@example.com', ROOMS_TRUST_LOOPBACK: '0' }, async base => {
    const r = await fetch(`${base}/api/cards/x/T1/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 403)
    const { error } = await r.json() as { error: string }
    assert.ok(error.endsWith(`at ${base}`), error)
  })
})
