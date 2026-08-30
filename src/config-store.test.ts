import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutoReviewConfigStore } from './config-store.js'

function memoryStore(global: unknown, project: unknown = {}) {
  const sources = new Map<string, string>()
  const store = new AutoReviewConfigStore({
    agentDir: '/agent',
    fileSystem: {
      readFile: path => sources.get(path), writeFile() {}, rename() {}, mkdir() {}, unlink() {},
    },
  })
  const paths = store.getPaths('/work/repo')
  sources.set(paths.globalPath, JSON.stringify(global))
  sources.set(paths.projectPath, JSON.stringify(project))
  return store
}

describe('global permanent permission config', () => {
  it('loads seeded permission defaults when rules are omitted', () => {
    const result = memoryStore({}).load('/work/repo')
    expect(result.config?.rules?.allow.paths).toEqual(['$CWD', '/tmp', '~/tmp', '~/.richie', '~/.pi', '~/warchives'])
    expect(result.config?.rules?.block.paths).toEqual([])
    expect(result.config?.rules?.allow.commands).toContain('npm test')
  })

  it('rejects permissions from project config', () => {
    const result = memoryStore({}, { rules: { allow: { commands: ['rm *'] } } }).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('rules')
  })

  it.each([
    [{ rules: { allow: { commands: [' git status '], paths: [] }, block: { commands: ['git status'], paths: [] } } }, 'command'],
    [{ rules: { allow: { commands: [], paths: ['/tmp'] }, block: { commands: [], paths: ['/tmp'] } } }, 'equal'],
    [{ rules: { allow: { commands: [], paths: ['/blocked/safe'] }, block: { commands: [], paths: ['/blocked'] } } }, 'ancestor'],
    [{ rules: { allow: { commands: [], paths: ['relative'] }, block: { commands: [], paths: [] } } }, 'absolute'],
  ])('fails closed for inconsistent rules (%s)', (global, message) => {
    const result = memoryStore(global).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain(message)
  })

  it('allows a narrower blocked subtree and deduplicates same-side rules', () => {
    const result = memoryStore({ rules: { allow: { commands: ['git status', 'git status'], paths: ['/work'] }, block: { commands: [], paths: ['/work/private'] } } }).load('/work/repo')
    expect(result.config?.rules?.allow.commands).toEqual(['git status'])
    expect(result.config?.rules?.block.paths).toEqual(['/work/private'])
  })
})

describe('AutoReviewConfigStore save', () => {
  it('updates a global config symlink target without replacing the symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-config-'))
    const agentDir = join(root, 'agent')
    const store = new AutoReviewConfigStore({ agentDir })
    const globalPath = store.getPaths(root).globalPath
    const target = join(root, 'shared-config.json')
    writeFileSync(target, '{}\n')
    mkdirSync(join(agentDir, 'extensions', 'pie-permission-auto-review-codex'), { recursive: true })
    symlinkSync(target, globalPath)

    const result = store.save(store.readScope(root, 'global'), { timeoutMs: 1234 })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).timeoutMs).toBe(1234)
    expect(lstatSync(globalPath).isSymbolicLink()).toBe(true)
  })
})
