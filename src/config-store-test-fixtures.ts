import { vi } from 'vitest'
import { AutoReviewConfigStore } from './config-store.js'

export function fakeConfigStore(global: unknown = { reviewer: 'sys1' }, project: unknown = {}) {
  const sources = new Map<string, string>()
  const fileSystem = {
    readFile: vi.fn((path: string) => sources.get(path)),
    writeFile: vi.fn((path: string, source: string) => { sources.set(path, source) }),
    rename: vi.fn((from: string, to: string) => { sources.set(to, sources.get(from)!); sources.delete(from) }),
    mkdir: vi.fn(), unlink: vi.fn((path: string) => { sources.delete(path) }),
  }
  const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
  const cwd = '/work/repo'
  const paths = store.getPaths(cwd)
  sources.set(paths.globalPath, JSON.stringify(global))
  sources.set(paths.projectPath, JSON.stringify(project))
  return { store, sources, fileSystem, cwd, paths }
}
