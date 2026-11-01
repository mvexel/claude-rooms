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
