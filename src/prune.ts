import { spawnSync } from 'node:child_process'
import { Room } from './room.ts'
import { mainRepositoryRoot, workerWorktree } from './repositories.ts'

export type PruneEntry = { item: string; repo: string; branch: string; worktree?: string; remove: boolean; why: string }

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

function worktreeOf(repo: string, branch: string): string | undefined {
  let path = ''
  for (const line of git(repo, 'worktree', 'list', '--porcelain').out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    else if (line === `branch refs/heads/${branch}`) return path
  }
}

// Worktrees and branches left by done or dropped items. Only those whose branch
// is merged into the integration branch or the repo's HEAD (which includes
// having no commits beyond base) and whose worktree is clean are removable.
export function pruneCandidates(r: Room): PruneEntry[] {
  const out: PruneEntry[] = []
  const integration = r.brief.get('code').split(' ')[0]
  for (const it of r.items()) {
    if (!['done', 'dropped'].includes(it.get('state'))) continue
    for (const repoPath of r.brief.list('repos')) {
      let repo: string
      try {
        repo = mainRepositoryRoot(repoPath)
      } catch {
        continue
      }
      const { branch } = workerWorktree(repo, r.name, it.get('id'))
      if (!git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok) continue
      const worktree = worktreeOf(repo, branch)
      const entry = { item: it.get('id'), repo, branch, worktree }
      const targets = [integration, 'HEAD'].filter(t => t && git(repo, 'rev-parse', '--verify', '-q', t).ok)
      const into = targets.find(t => git(repo, 'merge-base', '--is-ancestor', branch, t).ok)
      if (!into) out.push({ ...entry, remove: false, why: 'has commits not merged' })
      else if (worktree && git(worktree, 'status', '--porcelain').out) out.push({ ...entry, remove: false, why: 'worktree has uncommitted changes' })
      else out.push({ ...entry, remove: true, why: `merged into ${into}` })
    }
  }
  return out
}

export function pruneRoom(r: Room, yes: boolean): string {
  const list = pruneCandidates(r)
  if (!list.length) return `${r.name}: no worktrees or branches of done or dropped items`
  const lines = list.map(e => {
    const what = `${e.item} ${e.branch}${e.worktree ? ` (${e.worktree})` : ''}`
    if (!e.remove) return `keep   ${what}: ${e.why}`
    if (!yes) return `remove ${what}: ${e.why}`
    if (e.worktree) {
      const w = git(e.repo, 'worktree', 'remove', e.worktree)
      if (!w.ok) return `failed ${what}: git worktree remove`
    }
    const b = git(e.repo, 'branch', '-d', e.branch)
    return b.ok ? `removed ${what}` : `failed ${what}: git branch -d`
  })
  const n = list.filter(e => e.remove).length
  if (!yes && n) lines.push(`${n} removable; run: rooms prune ${r.name} --yes`)
  return lines.join('\n')
}
