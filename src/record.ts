import { readFileSync, writeFileSync } from 'node:fs'

// A record is a markdown file: `---` frontmatter of `key: value` lines, then
// `## Section` bodies. The parser keeps field order, unknown fields and
// unknown sections, so older record files round-trip (their
// templates carry inline `# comments`, which are read past and kept).

export class Record {
  path: string
  fields: [string, string, string][] = [] // key, value, trailing comment
  preamble = '' // body text before the first section
  sections: [string, string][] = []

  constructor(path: string, text?: string) {
    this.path = path
    if (text !== undefined) this.parse(text)
  }

  static load(path: string): Record {
    return new Record(path, readFileSync(path, 'utf8'))
  }

  parse(text: string): void {
    const m = text.match(/^---\n(?:([\s\S]*?)\n)?---(?:\n|$)([\s\S]*)$/)
    const front = m ? (m[1] ?? '') : ''
    const body = m ? m[2] : text
    for (const line of front.split('\n')) {
      const f = line.match(/^([A-Za-z_][\w-]*):(.*)$/)
      if (!f) continue
      const raw = f[2]
      const c = raw.match(/^(.*?)(\s+#\s.*)$/)
      this.fields.push([f[1], (c ? c[1] : raw).trim(), c ? c[2] : ''])
    }
    const parts = body.split(/^## /m)
    this.preamble = parts.shift() ?? ''
    for (const p of parts) {
      const nl = p.indexOf('\n')
      const name = (nl < 0 ? p : p.slice(0, nl)).trim()
      this.sections.push([name, nl < 0 ? '' : p.slice(nl + 1)])
    }
  }

  get(key: string): string {
    return this.fields.find(f => f[0] === key)?.[1] ?? ''
  }

  list(key: string): string[] {
    return parseList(this.get(key))
  }

  has(key: string): boolean {
    return this.fields.some(f => f[0] === key)
  }

  set(key: string, value: string | string[]): void {
    const v = Array.isArray(value) ? `[${value.join(', ')}]` : value
    const f = this.fields.find(f => f[0] === key)
    if (f) f[1] = v
    else this.fields.push([key, v, ''])
  }

  section(name: string): string {
    return this.sections.find(s => s[0] === name)?.[1].trim() ?? ''
  }

  setSection(name: string, text: string): void {
    const s = this.sections.find(s => s[0] === name)
    const body = text.trim() ? `${text.trim()}\n\n` : '\n'
    if (s) s[1] = body
    else this.sections.push([name, body])
  }

  appendTo(name: string, line: string): void {
    const cur = this.section(name)
    this.setSection(name, cur ? `${cur}\n${line}` : line)
  }

  toString(): string {
    const front = this.fields.map(([k, v, c]) => `${k}: ${v}${c}`.trimEnd()).join('\n')
    const body = this.sections.map(([n, b]) => `## ${n}\n${b}`).join('')
    return `---\n${front}\n---\n${this.preamble}${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  }

  save(): void {
    writeFileSync(this.path, this.toString())
  }
}

export function parseList(v: string): string[] {
  const s = v.trim().replace(/^\[|\]$/g, '')
  return s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

export function now(): string {
  return new Date().toISOString().slice(0, 16) + 'Z'
}

export function hhmm(): string {
  return new Date().toISOString().slice(11, 16) + 'Z'
}

export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '')
}
