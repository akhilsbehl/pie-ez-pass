import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

const FIXED_WRITE_DIRECTORIES = ['/tmp', 'tmp', '.richie', '.pi', 'warchives']

function expandHome(path: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }
  return path
}

function isWithinDirectory(directory: string, target: string): boolean {
  const remainder = relative(directory, target)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

/**
 * Returns whether an explicit edit/write target is in a directory that Pi can
 * allow without invoking the model reviewer.
 *
 * Paths are matched lexically after resolving `..` segments. Shell commands
 * are intentionally not handled here because their write target cannot be
 * determined safely from the command string.
 */
export function isDeterministicallyAllowedWritePath(requestedPath: string, cwd: string): boolean {
  if (requestedPath.length === 0 || cwd.length === 0) {
    return false
  }

  const sessionCwd = resolve(cwd)
  const target = resolve(sessionCwd, expandHome(requestedPath))
  const allowedDirectories = [
    sessionCwd,
    ...FIXED_WRITE_DIRECTORIES.map(directory => (directory === '/tmp' ? directory : resolve(homedir(), directory))),
  ]

  return allowedDirectories.some(directory => isWithinDirectory(directory, target))
}
