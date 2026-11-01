import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identity } from '../src/identity.ts'
import { agentDetail } from '../src/server.ts'

const sid = (n: number) => `${n.toString(16).padStart(8, '0')}-7329-45a8-97a4-85ae7e70c9cd`

test('identity is deterministic per session id', () => {
  assert.deepEqual(identity(sid(1)), identity(sid(1)))
  assert.equal(identity(sid(1)).svg, identity(sid(1).toUpperCase()).svg)
})

test('different sessions mostly differ; names are two words', () => {
  const ids = Array.from({ length: 60 }, (_, k) => identity(sid(k)))
  assert.ok(new Set(ids.map(i => i.name)).size > 40)
  assert.ok(new Set(ids.map(i => i.svg)).size > 55)
  for (const i of ids) assert.match(i.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
})

test('avatar is inline svg, mirrored, with no external references or script', () => {
  const { svg } = identity(sid(7))
  assert.match(svg, /^<svg [^>]*viewBox/)
  assert.doesNotMatch(svg, /<script|href=|url\(|<image/)
  const xs = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map(m => `${m[1]},${m[2]}`)
  for (const c of xs) { const [x, y] = c.split(',').map(Number); assert.ok(xs.includes(`${4 - x},${y}`)) }
})

test('agentDetail is exported', () => assert.equal(typeof agentDetail, 'function'))
