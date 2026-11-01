import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'settings-'))
process.env.CLAUDE_ROOMS_CONFIG = join(dir, 'config.json')
process.env.CLAUDE_ROOMS_OVERRIDES = join(dir, 'overrides.json')
const { config, configLayers, validatePatch, mergePatch, checkEffective, saveOverrides } = await import('../src/config.ts')
const { settingsFields } = await import('../src/server.ts')

test('defaults come from code, tagged default', () => {
  assert.equal(config().worker.tier, 'standard')
  assert.ok(settingsFields().every(f => f.source === 'default'))
})

test('hand-edited config.json is tagged overridden and never rewritten', () => {
  const text = '{ "provisionalMinutes": 90 }\n'
  writeFileSync(process.env.CLAUDE_ROOMS_CONFIG!, text)
  assert.equal(config().provisionalMinutes, 90)
  const f = settingsFields().find(x => x.key === 'provisionalMinutes')!
  assert.deepEqual([f.source, f.from], ['overridden', 'config.json'])
  const l = configLayers()
  saveOverrides(mergePatch(l.overrides, validatePatch({ tiers: { light: { model: 'm1' } } })))
  assert.equal(readFileSync(process.env.CLAUDE_ROOMS_CONFIG!, 'utf8'), text)
})

test('overrides file is re-read when it changes; tier merge keeps other fields', () => {
  assert.equal(config().tiers.light.model, 'm1')
  assert.equal(config().tiers.light.effort, 'medium')
  const next = mergePatch(configLayers().overrides, validatePatch({ tiers: { light: { model: 'm2' } }, provisionalMinutes: 45 }))
  checkEffective(next, configLayers().file)
  saveOverrides(next)
  assert.equal(config().tiers.light.model, 'm2')
  assert.equal(config().provisionalMinutes, 45) // the page beats config.json
  assert.ok(!existsSync(join(dir, 'overrides.json.' + process.pid + '.tmp')))
  assert.equal(settingsFields().find(x => x.key === 'tiers.light.model')!.from, 'page')
})

test('null resets a key to the default', () => {
  saveOverrides(mergePatch(configLayers().overrides, validatePatch({ tiers: { light: { model: null } } })))
  assert.equal(config().tiers.light.model, 'claude-haiku-5-5')
})

test('invalid patches are refused; the lead privilege keys are file-only', () => {
  for (const bad of [{ provisionalMinutes: 5 }, { provisionalMinutes: 'x' }, { tiers: { a: { model: '' } } }, { tiers: { a: { color: 'x' } } }, { lead: { permissionMode: 'auto' } }, { lead: { allowedTools: [] } }, { worker: { permissionMode: 'nope' } }, { bogus: 1 }, []])
    assert.throws(() => validatePatch(bad), undefined, JSON.stringify(bad))
  assert.throws(() => checkEffective(mergePatch({}, validatePatch({ worker: { tier: 'ghost' } })), {}), /not a defined tier/)
})

test('a hand-written overrides file cannot set the lead privileges', () => {
  writeFileSync(process.env.CLAUDE_ROOMS_OVERRIDES!, JSON.stringify({ lead: { permissionMode: 'bypassPermissions' } }))
  assert.equal(config().lead.permissionMode, 'auto')
})
