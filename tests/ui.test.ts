import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the dependency graph and disclosure without a browser dependency.
class Element {
  tagName: string; children: any[] = []; attrs: any = {}; handlers: any = {}; hidden = false; className = ''; scrollLeft = 0; scrollTop = 0
  constructor(tag: string) { this.tagName = tag }
  setAttribute(k: string, v: any) { this.attrs[k] = v; if (k === 'hidden') this.hidden = true }
  addEventListener(k: string, fn: any) { this.handlers[k] = fn }
  append(...children: any[]) { this.children.push(...children) }
  get nodeType() { return 1 }
  querySelector(selector: string): any {
    return this.children.find(c => c.className?.split(' ').includes(selector.slice(1))) || this.children.map(c => c.querySelector?.(selector)).find(Boolean)
  }
}
function page() {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const script = html.split('<script>')[1].split('</script>')[0].split('const t0 =')[0]
  const context: any = {
    document: { querySelector: () => new Element('div'), createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => ({ nodeType: 3, text }), addEventListener() {} },
    location: { pathname: '/', hash: '' }, localStorage: { getItem: () => null },
    addEventListener() {}, setInterval() {}, requestAnimationFrame: (fn: any) => fn(),
  }
  runInNewContext(script + '\nglobalThis.ui = ui; globalThis.planView = planView; globalThis.planLayout = planLayout;', context)
  return context
}
const item = (id: string, after: string[] = [], state = 'todo') => ({ id, after, state, title: 'Work ' + id, summary: 'A short summary' })

test('graph places branches, joins, completed steps and disconnected items; cycles terminate', () => {
  const p = page()
  const columns = p.planLayout([item('A', [], 'done'), item('B', ['A']), item('C', ['A']), item('D', ['B', 'C']), item('E', [], 'dropped')])
  assert.deepEqual(Array.from(columns, (col: any) => Array.from(col, (i: any) => i.id)), [['A', 'E'], ['B', 'C'], ['D']])
  assert.equal(p.planLayout([item('A', ['B']), item('B', ['A'])])[0].length, 2)
  assert.equal(p.planLayout([item('A', ['missing'])]).length, 1)
})

test('plan starts collapsed, opens once, keeps state across redraws and opens records', () => {
  const p = page(), items = [item('A', [], 'done'), item('B', ['A'])]
  let selected: any
  p.select = (...args: any[]) => { selected = args }
  runInNewContext('openRecord = select', p)
  const panel = p.planView('demo', items), [toggle, body] = panel.children
  assert.equal(body.hidden, true)
  assert.equal(body.children.length, 0)
  toggle.handlers.click()
  assert.equal(body.hidden, false)
  assert.equal(toggle.attrs['aria-expanded'], 'true')
  const scroll = body.children[1], canvas = scroll.children[0]
  assert.equal(canvas.children.filter((c: any) => c.tagName === 'button').length, 2)
  assert.equal(canvas.children[0].children.filter((c: any) => c.tagName === 'path').length, 1)
  canvas.children[2].handlers.click()
  assert.deepEqual(selected, ['demo', 'B'])
  scroll.scrollLeft = 80; scroll.scrollTop = 10; scroll.handlers.scroll({ target: scroll })
  const redrawn = p.planView('demo', items)
  assert.equal(redrawn.children[1].hidden, false)
  assert.equal(redrawn.children[1].children[1].scrollLeft, 80)
  toggle.handlers.click(); toggle.handlers.click()
  assert.equal(body.children.length, 3)
})

const text = (n: any): string => n == null ? '' : n.nodeType === 3 ? n.text : (n.children || []).map(text).join('')
test('finished steps hide behind one stub by default; per-room toggle shows them; stages list keeps dependencies', () => {
  const p = page(), items = [item('A', [], 'done'), item('X', [], 'dropped'), item('B', ['A', 'X']), item('C', ['B'])]
  p.ui.openPlans.add('demo')
  let body = p.planView('demo', items).children[1], canvas = body.children[1].children[0], list = body.children[2]
  const nodes = canvas.children.filter((c: any) => c.tagName === 'button')
  assert.equal(nodes.length, 3) // stub, B, C
  assert.match(text(nodes[0]), /1 done · 1 dropped/)
  assert.equal(canvas.children[0].children.filter((c: any) => c.tagName === 'path').length, 2) // stub→B, B→C
  assert.match(text(list), /2 finished steps hidden/)
  assert.match(text(list), /Stage 1.*Work B.*After 2 finished.*Stage 2.*Work C.*After B/)
  p.ui.planAll.add('demo')
  body = p.planView('demo', items).children[1]; canvas = body.children[1].children[0]; list = body.children[2]
  assert.equal(canvas.children.filter((c: any) => c.tagName === 'button').length, 4)
  assert.match(text(list), /After A ✓, X \(dropped\)/)
})
