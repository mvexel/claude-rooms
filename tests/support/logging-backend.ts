import { appendFileSync } from 'node:fs'
import { localBackend, type Backend } from '../../src/backend.ts'

// The local files backend, noting every call in $BACKEND_LOG: stands in for a
// module chosen with CLAUDE_ROOMS_BACKEND.
const note = (op: string, path: string) => appendFileSync(process.env.BACKEND_LOG!, `${op} ${path}\n`)

export default function (settings?: unknown): Backend {
  if (settings) note('settings', JSON.stringify(settings))
  return {
    read: p => (note('read', p), localBackend.read(p)),
    write: (p, t) => (note('write', p), localBackend.write(p, t)),
    append: (p, t) => (note('append', p), localBackend.append(p, t)),
    exists: p => (note('exists', p), localBackend.exists(p)),
    list: d => (note('list', d), localBackend.list(d)),
    remove: p => (note('remove', p), localBackend.remove(p)),
    claim: p => (note('claim', p), localBackend.claim(p)),
  }
}
