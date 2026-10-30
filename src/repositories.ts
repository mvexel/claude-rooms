import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

function gitPath(path: string, arg: string): string | undefined {
  const r = spawnSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', arg], { encoding: 'utf8' })
  return r.status === 0 ? realpathSync(r.stdout.trim()) : undefined
}

// Keep a readable checkout path in the brief; compare the shared Git directory
// so subdirectories, symlinks and linked worktrees all identify the same repo.
export function repositoryRoot(path: string): string {
  const physical = realpathSync(resolve(path))
  return gitPath(physical, '--show-toplevel') ?? physical
}

export function repositoryIdentity(path: string): string {
  const physical = realpathSync(resolve(path))
  return gitPath(physical, '--git-common-dir') ?? physical
}

// The main checkout: the parent of the shared Git directory, so a linked
// worktree passed as --repo still names new worktrees after the real repo.
export function mainRepositoryRoot(path: string): string {
  const common = repositoryIdentity(path)
  return basename(common) === '.git' ? dirname(common) : repositoryRoot(path)
}

export function workerWorktree(repo: string, room: string, id: string): { path: string; branch: string } {
  return { path: `${mainRepositoryRoot(repo)}-${room}-${id.toLowerCase()}`, branch: `rooms/${room}/${id.toLowerCase()}` }
}
