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
  for (const bad of [{ provisionalMinutes: 5 }, { provisionalMinutes: 'x' }, { tiers: { a: { model: '' } } }, { tiers: { a: { color: 'x' } } }, { lead: { permissionMode: 'auto' } }, { lead: { allowedTools: [] } }, { worker: { permissionMode: 'auto' } }, { tiers: { a: { model: '--dangerous' } } }, { lead: { model: ' -x' } }, { tiers: { a: { effort: '-1' } } }, { bogus: 1 }, []])
    assert.throws(() => validatePatch(bad), undefined, JSON.stringify(bad))
  assert.throws(() => checkEffective(mergePatch({}, validatePatch({ worker: { tier: 'ghost' } })), {}), /not a defined tier/)
})

test('a hand-written overrides file cannot set privileges; the rest still applies and the error shows', () => {
  writeFileSync(process.env.CLAUDE_ROOMS_OVERRIDES!, JSON.stringify({ lead: { permissionMode: 'bypassPermissions' }, worker: { permissionMode: 'bypassPermissions', tier: 'review' } }))
  assert.equal(config().lead.permissionMode, 'auto')
  assert.equal(config().worker.permissionMode, 'auto')
  assert.equal(config().worker.tier, 'review')
  assert.match(configLayers().overridesError!, /lead\.permissionMode, worker\.permissionMode/)
})

test('an invalid overrides file is ignored whole and its error is reported', () => {
  writeFileSync(process.env.CLAUDE_ROOMS_OVERRIDES!, JSON.stringify({ provisionalMinutes: 3 }))
  assert.equal(config().provisionalMinutes, 90)
  assert.match(configLayers().overridesError!, /provisionalMinutes/)
  writeFileSync(process.env.CLAUDE_ROOMS_OVERRIDES!, '{ not json')
  assert.match(configLayers().overridesError!, /unreadable/)
})

test('a top-level null resets a whole section', () => {
  saveOverrides({ tiers: { light: { model: 'm9' } }, worker: { tier: 'review' }, lead: { model: 'z' }, provisionalMinutes: 50 })
  const next = mergePatch(configLayers().overrides, validatePatch({ tiers: null, worker: null, lead: null, provisionalMinutes: null }))
  assert.deepEqual(next, {})
})

test('hallMonitor fields are editable, validated, and applied on reload', () => {
  const f = settingsFields().filter(x => x.key.startsWith('hallMonitor.'))
  assert.deepEqual(f.map(x => [x.key, x.editable]).sort(), [['hallMonitor.maxThreads', true], ['hallMonitor.queueLimit', true]])
  for (const bad of [{ hallMonitor: { maxThreads: 0 } }, { hallMonitor: { maxThreads: 'x' } }, { hallMonitor: { queueLimit: -1 } }, { hallMonitor: { queueLimit: 1.5 } }, { hallMonitor: { other: 1 } }])
    assert.throws(() => validatePatch(bad), undefined, JSON.stringify(bad))
  saveOverrides(mergePatch(configLayers().overrides, validatePatch({ hallMonitor: { maxThreads: 7, queueLimit: 0 } })))
  assert.deepEqual(config().hallMonitor, { maxThreads: 7, queueLimit: 0 })
  assert.equal(settingsFields().find(x => x.key === 'hallMonitor.maxThreads')!.from, 'page')
  saveOverrides(mergePatch(configLayers().overrides, validatePatch({ hallMonitor: { maxThreads: null, queueLimit: null } })))
  assert.deepEqual(config().hallMonitor, { maxThreads: 4, queueLimit: 1 })
})

test('config.json hallMonitor out of range is dropped with a reason', () => {
  writeFileSync(process.env.CLAUDE_ROOMS_CONFIG!, '{ "hallMonitor": { "maxThreads": 0, "queueLimit": 2 } }\n')
  assert.deepEqual(config().hallMonitor, { maxThreads: 4, queueLimit: 2 })
  assert.match(configLayers().fileError!, /maxThreads must be a whole number of at least 1/)
})
