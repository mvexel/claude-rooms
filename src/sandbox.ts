import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { claudeDir, roomsHome } from './config.ts'

// Claude Code's Bash sandbox writes only to the session's working directory
// and temp, and a plugin cannot widen that. Everything rooms writes lives
// under roomsHome(), so one entry in the user's sandbox.filesystem.allowWrite
// covers it. `rooms install` offers to add it; the hook warns when it's missing.

type Settings = { sandbox?: { enabled?: boolean; filesystem?: { allowWrite?: string[] } }; permissions?: { additionalDirectories?: string[] } }

export const userSettingsFile = () => join(claudeDir(), 'settings.json')

function read(file: string): Settings | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function expand(p: string, base: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return resolve(base, p.replace(/^\/\//, '/'))
}

// The way to write path in settings: under home, as ~/...
export function tilde(p: string): string {
  const home = homedir()
  return p === home || p.startsWith(home + sep) ? '~' + p.slice(home.length) : p
}

function covers(entries: string[], base: string, path: string): boolean {
  return entries.some(e => {
    const dir = expand(e, base).replace(/\/+$/, '')
    return path === dir || path.startsWith(dir + sep)
  })
}

// Settings scopes a session in cwd reads: user, then project and local.
function scopes(cwd: string): [Settings, string][] {
  const files: [string, string][] = [
    [userSettingsFile(), homedir()],
    [join(cwd, '.claude', 'settings.json'), cwd],
    [join(cwd, '.claude', 'settings.local.json'), cwd],
  ]
  return files.flatMap(([f, base]) => {
    const s = read(f)
    return s ? [[s, base] as [Settings, string]] : []
  })
}

// Why a sandboxed session in cwd could not write the rooms home, or '' if it can.
export function sandboxGap(cwd = process.cwd()): string {
  const all = scopes(cwd)
  const enabled = all.reduce<boolean | undefined>((on, [s]) => s.sandbox?.enabled ?? on, undefined)
  if (!enabled) return ''
  const home = resolve(roomsHome())
  if (home === cwd || home.startsWith(cwd + sep)) return ''
  const allowed = all.some(([s, base]) =>
    covers(s.sandbox?.filesystem?.allowWrite ?? [], base, home) ||
    covers(s.permissions?.additionalDirectories ?? [], base, home))
  return allowed ? '' : `the Bash sandbox can't write ${tilde(home)}, so rooms commands that change a room will fail`
}

// Add the rooms home to the user's sandbox.filesystem.allowWrite. Keeps the
// file's indentation and leaves a .bak beside it.
export function planUserSandbox(): { file: string; entry: string; already: boolean; error?: string } {
  const file = userSettingsFile()
  const entry = tilde(resolve(roomsHome()))
  if (!existsSync(file)) return { file, entry, already: false }
  const s = read(file)
  if (!s) return { file, entry, already: false, error: `${file} is not valid JSON; add "${entry}" to sandbox.filesystem.allowWrite yourself` }
  return { file, entry, already: covers(s.sandbox?.filesystem?.allowWrite ?? [], homedir(), resolve(roomsHome())) }
}

export function applyUserSandbox(): string {
  const { file, entry, already, error } = planUserSandbox()
  if (error) throw new Error(error)
  if (already) return `${file} already lets the sandbox write ${entry}`
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n'
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
  const s = JSON.parse(text) as Settings
  s.sandbox ??= {}
  s.sandbox.filesystem ??= {}
  s.sandbox.filesystem.allowWrite = [...(s.sandbox.filesystem.allowWrite ?? []), entry]
  if (existsSync(file)) copyFileSync(file, file + '.bak')
  writeFileSync(file + '.tmp', JSON.stringify(s, null, indent) + '\n')
  renameSync(file + '.tmp', file)
  return `added "${entry}" to sandbox.filesystem.allowWrite in ${file}${existsSync(file + '.bak') ? ` (previous version: ${file}.bak)` : ''}. Restart open Claude Code sessions to pick it up.`
}
