import { codexLiveness, codexStatusWord, isCodex } from './codex.ts'
import { type Liveness, type Session, findSession, liveness } from './sessions.ts'

// Which worker backend runs an item: `backend:` on the record, absent = claude
// (old records and Claude-only rooms are unchanged). Everything that asks
// "is this item's worker alive?" goes through here, so Codex items never meet
// the Claude session list (which cannot see them).

export type WorkerBackend = 'claude' | 'codex'
export const BACKENDS: WorkerBackend[] = ['claude', 'codex']

type ItemLike = { get(k: string): string }

export function backendOf(it: ItemLike): WorkerBackend {
  return isCodex(it) ? 'codex' : 'claude'
}

export type Worker = {
  backend: WorkerBackend
  live: Liveness
  session?: Session // claude only
  word?: string // codex: working | idle | failed | exited unexpectedly | unknown
}

export function workerOf(roomName: string, it: ItemLike, sessions: Session[]): Worker {
  if (isCodex(it)) {
    const { live } = codexLiveness(roomName, it.get('id'))
    return { backend: 'codex', live, word: codexStatusWord(roomName, it.get('id')) }
  }
  const agent = it.get('agent')
  const session = agent ? findSession(agent, sessions) : undefined
  return { backend: 'claude', live: agent ? liveness(session ?? agent, sessions) : 'dead', session }
}
