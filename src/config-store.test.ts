import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutoReviewConfigStore } from './config-store.js'
import { fakeConfigStore } from './config-store-test-fixtures.js'
import { autoReviewConfigSchema } from './config.js'

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
    const result = memoryStore({ reviewer: 'sys1' }).load('/work/repo')
    expect(result.config?.rules).toEqual({ allow: { commands: [], paths: [] }, block: { commands: [], paths: [] } })
  })

  it('rejects permissions from project config', () => {
    const result = memoryStore({ reviewer: 'sys1' }, { rules: { allow: { commands: ['rm *'] } } }).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('rules')
  })

  it.each([
    { reviewer: 'sys1', rules: { typo: {} } },
    { reviewer: 'sys1', rules: { allow: { commands: [], paths: [], typo: true } } },
    { reviewer: 'sys1', rules: { block: { commands: [], paths: [], typo: true } } },
  ])('fails closed for unknown nested rule fields (%s)', global => {
    const result = memoryStore(global).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('Unrecognized key')
  })

  it.each([
    [{ reviewer: 'sys1', rules: { allow: { commands: [' git status '], paths: [] }, block: { commands: ['git status'], paths: [] } } }, 'command'],
    [{ reviewer: 'sys1', rules: { allow: { commands: [], paths: ['/tmp'] }, block: { commands: [], paths: ['/tmp'] } } }, 'equal'],
    [{ reviewer: 'sys1', rules: { allow: { commands: [], paths: ['relative'] }, block: { commands: [], paths: [] } } }, 'absolute'],
  ])('fails closed for inconsistent rules (%s)', (global, message) => {
    const result = memoryStore(global).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain(message)
  })

  it('allows narrower opposite-side subtrees and deduplicates same-side rules', () => {
    const result = memoryStore({ reviewer: 'sys1', rules: { allow: { commands: ['git status', 'git status'], paths: ['/blocked/safe'] }, block: { commands: [], paths: ['/blocked'] } } }).load('/work/repo')
    expect(result.config?.rules?.allow.commands).toEqual(['git status'])
    expect(result.config?.rules?.allow.paths).toEqual(['/blocked/safe'])
  })

  it('fails closed for opposite lexical paths resolving to the same canonical root', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-rules-'))
    const alias = join(root, 'alias')
    const target = join(root, 'target')
    mkdirSync(target)
    symlinkSync(target, alias)
    const result = memoryStore({ reviewer: 'sys1', rules: { allow: { commands: [], paths: [alias] }, block: { commands: [], paths: [target] } } }).load(root)
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('canonical')
  })
})

describe('sys1 configuration', () => {
  it('fails closed when reviewer is missing from both layers', () => {
    const result = memoryStore({}, {}).load('/work/repo')
    expect(result.config).toBeUndefined()
    expect(result.issues.map(issue => issue.message).join('\n')).toContain('reviewer')
  })

  it('defaults the sys1 threshold to 0.6 when omitted', () => {
    const result = memoryStore({ reviewer: 'sys1' }).load('/work/repo')
    expect(result.config?.reviewer).toBe('sys1')
    expect(result.config?.sys1_escalate_threshold).toBe(0.6)
  })

  it('accepts explicit sys2 selection and project threshold override', () => {
    const result = memoryStore({ reviewer: 'sys1' }, { reviewer: 'sys2', sys1_escalate_threshold: 0.8 }).load('/work/repo')
    expect(result.config?.reviewer).toBe('sys2')
    expect(result.config?.sys1_escalate_threshold).toBe(0.8)
  })

  it.each([[-0.1], [1.1], ['high'], [Number.NaN]])('fails closed for invalid threshold %s', value => {
    const result = memoryStore({ reviewer: 'sys1', sys1_escalate_threshold: value }).load('/work/repo')
    expect(result.config).toBeUndefined()
  })

  it('fails closed for unknown reviewer', () => {
    const result = memoryStore({ reviewer: 'yes' }).load('/work/repo')
    expect(result.config).toBeUndefined()
  })
})

describe('clean breaking config and persistence', () => {
  it.each(['use_jev', 'jev_escalate_confidence_threshold', 'provider', 'model', 'reasoning'])('rejects legacy key %s in either layer, including mixed canonical config', key => {
    for (const [global, project] of [
      [{ reviewer: 'sys1', [key]: true }, {}],
      [{ reviewer: 'sys1' }, { [key]: true }],
    ]) expect(memoryStore(global, project).load('/work/repo').config).toBeUndefined()
  })
  it('retains two independent model pairs and merges partial overrides by field', () => {
    const result = memoryStore(
      { reviewer: 'sys1', sys1_provider: 'p1', sys1_model: 'm1', sys2_provider: 'p2', sys2_model: 'm2' },
      { reviewer: 'sys2', sys1_model: 'project-m1', sys2_provider: 'project-p2' },
    ).load('/work/repo')
    expect(result.config).toMatchObject({ reviewer: 'sys2', sys1_provider: 'p1', sys1_model: 'project-m1', sys2_provider: 'project-p2', sys2_model: 'm2', timeoutMs: 30000 })
  })
  it('checks canonical defaults, inclusive threshold bounds and timeout range', () => {
    const defaults = autoReviewConfigSchema.parse({ reviewer: 'sys1' })
    expect(defaults).toMatchObject({ sys1_provider: 'openrouter', sys1_model: 'typesafe/jev-1.13', sys2_provider: 'openai-codex', sys2_model: 'codex-auto-review', sys2_reasoning: 'low', timeoutMs: 30000, sys1_escalate_threshold: 0.6 })
    for (const threshold of [0, 1]) expect(autoReviewConfigSchema.safeParse({ reviewer: 'sys1', sys1_escalate_threshold: threshold }).success).toBe(true)
    for (const timeout of [1, 300000]) expect(autoReviewConfigSchema.safeParse({ reviewer: 'sys2', timeoutMs: timeout }).success).toBe(true)
    for (const timeout of [0, 300001, 1.5]) expect(autoReviewConfigSchema.safeParse({ reviewer: 'sys2', timeoutMs: timeout }).success).toBe(false)
  })
  it('never writes on load, including invalid legacy config', () => {
    const files = fakeConfigStore({ use_jev: true })
    const before = new Map(files.sources)
    files.store.load(files.cwd); files.store.readScope(files.cwd, 'global')
    expect(files.sources).toEqual(before); expect(files.fileSystem.writeFile).not.toHaveBeenCalled()
  })
  it('refuses invalid effective saves and conflicts; write failure cleans the temp file', () => {
    const files = fakeConfigStore()
    const snapshot = files.store.readScope(files.cwd, 'global')
    expect(files.store.save(snapshot, {})).toMatchObject({ ok: false })
    files.sources.set(files.paths.globalPath, '{"reviewer":"sys2"}')
    expect(files.store.save(snapshot, { reviewer: 'sys1' })).toMatchObject({ ok: false, message: expect.stringContaining('changed while') })
    const current = files.store.readScope(files.cwd, 'global')
    files.fileSystem.rename.mockImplementation(() => { throw new Error('rename failed') })
    expect(files.store.save(current, { reviewer: 'sys1' })).toMatchObject({ ok: false, message: expect.stringContaining('rename failed') })
    expect(files.sources.has(files.paths.globalPath + '.tmp')).toBe(false)
  })
})

describe('AutoReviewConfigStore save', () => {
  it('updates a global config symlink target without replacing the symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-config-'))
    const agentDir = join(root, 'agent')
    const store = new AutoReviewConfigStore({ agentDir })
    const globalPath = store.getPaths(root).globalPath
    const target = join(root, 'shared-config.json')
    writeFileSync(target, '{"reviewer":"sys1"}\n')
    mkdirSync(join(agentDir, 'extensions', 'pie-ez-pass'), { recursive: true })
    symlinkSync(target, globalPath)

    const result = store.save(store.readScope(root, 'global'), { reviewer: 'sys1', timeoutMs: 1234 })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).timeoutMs).toBe(1234)
    expect(lstatSync(globalPath).isSymbolicLink()).toBe(true)
  })
})
