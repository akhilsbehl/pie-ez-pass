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
  it('loads empty permission defaults when rules are omitted', () => {
    const result = memoryStore({ use_jev: true }).load('/work/repo')
    expect(result.config?.rules).toEqual({ allow: { commands: [], paths: [] }, block: { commands: [], paths: [] } })
  })

  it('rejects permissions from project config', () => {
    const result = memoryStore({ use_jev: true }, { rules: { allow: { commands: ['rm *'] } } }).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('rules')
  })

  it.each([
    { use_jev: true, rules: { typo: {} } },
    { use_jev: true, rules: { allow: { commands: [], paths: [], typo: true } } },
    { use_jev: true, rules: { block: { commands: [], paths: [], typo: true } } },
  ])('fails closed for unknown nested rule fields (%s)', global => {
    const result = memoryStore(global).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('Unrecognized key')
  })

  it.each([
    [{ use_jev: true, rules: { allow: { commands: [' git status '], paths: [] }, block: { commands: ['git status'], paths: [] } } }, 'command'],
    [{ use_jev: true, rules: { allow: { commands: [], paths: ['/tmp'] }, block: { commands: [], paths: ['/tmp'] } } }, 'equal'],
    [{ use_jev: true, rules: { allow: { commands: [], paths: ['relative'] }, block: { commands: [], paths: [] } } }, 'absolute'],
  ])('fails closed for inconsistent rules (%s)', (global, message) => {
    const result = memoryStore(global).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain(message)
  })

  it('allows narrower opposite-side subtrees and deduplicates same-side rules', () => {
    const result = memoryStore({ use_jev: true, rules: { allow: { commands: ['git status', 'git status'], paths: ['/blocked/safe'] }, block: { commands: [], paths: ['/blocked'] } } }).load('/work/repo')
    expect(result.config?.rules?.allow.commands).toEqual(['git status'])
    expect(result.config?.rules?.allow.paths).toEqual(['/blocked/safe'])
  })

  it('fails closed for opposite lexical paths resolving to the same canonical root', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-rules-'))
    const alias = join(root, 'alias')
    const target = join(root, 'target')
    mkdirSync(target)
    symlinkSync(target, alias)
    const result = memoryStore({ use_jev: true, rules: { allow: { commands: [], paths: [alias] }, block: { commands: [], paths: [target] } } }).load(root)
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('canonical')
  })
})

describe('JEV configuration', () => {
  it('fails closed when use_jev is missing from both layers', () => {
    const result = memoryStore({}, {}).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues.map(issue => issue.message).join('\n')).toContain('use_jev')
  })

  it('defaults the JEV threshold to 0.95 when omitted', () => {
    const result = memoryStore({ use_jev: true }).load('/work/repo')
    expect(result.config?.use_jev).toBe(true)
    expect(result.config?.jev_accept_confidence_threshold).toBe(0.95)
  })

  it('accepts explicit JEV selection and project threshold override', () => {
    const result = memoryStore({ use_jev: true }, { use_jev: false, jev_accept_confidence_threshold: 0.8 }).load('/work/repo')
    expect(result.config?.use_jev).toBe(false)
    expect(result.config?.jev_accept_confidence_threshold).toBe(0.8)
  })

  it.each([[-0.1], [1.1], ['high'], [Number.NaN]])('fails closed for invalid threshold %s', value => {
    const result = memoryStore({ use_jev: true, jev_accept_confidence_threshold: value }).load('/work/repo')
    expect(result.config).toBeUndefined()
  })

  it('fails closed for non-boolean use_jev', () => {
    const result = memoryStore({ use_jev: 'yes' }).load('/work/repo')
    expect(result.config).toBeUndefined()
  })
})

describe('AutoReviewConfigStore save', () => {
  it('updates a global config symlink target without replacing the symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-config-'))
    const agentDir = join(root, 'agent')
    const store = new AutoReviewConfigStore({ agentDir })
    const globalPath = store.getPaths(root).globalPath
    const target = join(root, 'shared-config.json')
    writeFileSync(target, '{"use_jev":true}\n')
    mkdirSync(join(agentDir, 'extensions', 'pie-ez-pass'), { recursive: true })
    symlinkSync(target, globalPath)

    const result = store.save(store.readScope(root, 'global'), { use_jev: true, timeoutMs: 1234 })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).timeoutMs).toBe(1234)
    expect(lstatSync(globalPath).isSymbolicLink()).toBe(true)
  })
})
