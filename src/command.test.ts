import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAutoReviewCommand } from './command.js'
import { pickReviewModel } from './model-picker.js'
import { fakeConfigStore } from './config-store-test-fixtures.js'
import { fakeRegistry } from './reviewer-test-fixtures.js'

vi.mock('./model-picker.js', () => ({ pickReviewModel: vi.fn() }))
beforeEach(() => vi.mocked(pickReviewModel).mockReset())
function setup(global: unknown = { reviewer: 'sys1' }, project: unknown = {}) {
  const files = fakeConfigStore(global, project)
  const models = fakeRegistry()
  let command!: Parameters<ExtensionAPI['registerCommand']>[1]
  const pi = { registerCommand: vi.fn((_name: string, cmd: typeof command) => { command = cmd }) }
  const applyConfig = vi.fn(() => ({ kind: 'active' as const }))
  registerAutoReviewCommand(pi as never, { configStore: files.store, applyConfig })
  const select = vi.fn(async (_title: string, _choices: string[]): Promise<string | undefined> => undefined)
  const notify = vi.fn()
  const ui = { select, notify, input: vi.fn(), editor: vi.fn() }
  const ctx = { cwd: files.cwd, mode: 'tui', ui, waitForIdle: vi.fn(async () => {}), modelRegistry: models.registry } as unknown as ExtensionCommandContext
  function choices(...actions: Array<string | undefined>) {
    select.mockImplementation(async (_title, options) => {
      const action = actions.shift()
      return action === undefined ? undefined : options.find(option => option.startsWith(action))
    })
  }
  return { ...files, ...models, command, ctx, ui, applyConfig, choices, pi }
}

describe('/ez-pass command', () => {
  it('requires TUI only for editing, supports path/help/completions and no reset', async () => {
    const run = setup()
    await run.command.handler('', { ...run.ctx, mode: 'rpc' })
    expect(run.ui.notify).toHaveBeenCalledWith(expect.stringContaining('TUI mode'), 'warning')
    expect(run.ctx.waitForIdle).not.toHaveBeenCalled()
    await run.command.handler('path', run.ctx)
    expect(run.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(run.paths.globalPath), 'info')
    await run.command.handler('help', run.ctx)
    expect(run.ui.notify).toHaveBeenLastCalledWith('Usage: /ez-pass [show|path|help]', 'info')
    await run.command.handler('reset', run.ctx)
    expect(run.ui.notify).toHaveBeenLastCalledWith('Usage: /ez-pass [show|path|help]', 'warning')
    expect(run.command.getArgumentCompletions?.('sh')).toMatchObject([{ value: 'show' }])
    expect(run.command.getArgumentCompletions?.('reset')).toBeNull()
    expect(run.fileSystem.writeFile).not.toHaveBeenCalled()
  })
  it('Cancel, escape in picker and settings leave both files untouched', async () => {
    const run = setup()
    run.choices('Project', 'sys1 model:', 'Cancel')
    vi.mocked(pickReviewModel).mockResolvedValue(undefined)
    await run.command.handler('', run.ctx)
    expect(run.ctx.waitForIdle).toHaveBeenCalledOnce()
    expect(run.fileSystem.writeFile).not.toHaveBeenCalled()
    expect(run.applyConfig).not.toHaveBeenCalled()
  })
  it('sets provider/model atomically, preserves both inactive fields, saves only chosen layer, and activates', async () => {
    const run = setup({ reviewer: 'sys1', sys2_provider: 'kept', sys2_model: 'inactive' }, { timeoutMs: 100 })
    const globalSource = run.sources.get(run.paths.globalPath)
    run.choices('Project', 'sys1 model:', 'Reviewer:', 'sys2', 'Save')
    vi.mocked(pickReviewModel).mockResolvedValue({ kind: 'model', model: { provider: 'test', id: 'classify' } })
    await run.command.handler('', run.ctx)
    const project = JSON.parse(run.sources.get(run.paths.projectPath)!)
    expect(project).toMatchObject({ sys1_provider: 'test', sys1_model: 'classify', reviewer: 'sys2', timeoutMs: 100 })
    expect(project).not.toHaveProperty('sys2_model')
    expect(project).not.toHaveProperty('rules')
    expect(run.sources.get(run.paths.globalPath)).toBe(globalSource)
    expect(run.applyConfig).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ reviewer: 'sys2', sys2_provider: 'kept', sys2_model: 'inactive' }) }))
    expect(run.mocks.getAvailableOfType).toHaveBeenCalledWith('classifier', 'test', { signal: expect.any(AbortSignal) })
  })
  it('pair Inherit removes both selected-layer keys while retaining field-level layering elsewhere', async () => {
    const run = setup({ reviewer: 'sys1', sys1_provider: 'global-p', sys1_model: 'global-m' }, { sys1_provider: 'project-p', sys1_model: 'project-m', sys2_model: 'partial', timeoutMs: 123 })
    run.choices('Project', 'sys1 model:', 'Save')
    vi.mocked(pickReviewModel).mockResolvedValue({ kind: 'inherit' })
    await run.command.handler('', run.ctx)
    expect(vi.mocked(pickReviewModel)).toHaveBeenCalledWith(run.ctx, 'sys1', { provider: 'project-p', id: 'project-m' }, { provider: 'global-p', id: 'global-m' })
    expect(JSON.parse(run.sources.get(run.paths.projectPath)!)).toEqual({ $schema: expect.any(String), sys2_model: 'partial', timeoutMs: 123 })
  })
  it('new-choice auth race at Save is refused without writes, and cancellation remains possible', async () => {
    const run = setup()
    run.choices('Project', 'sys2 model:', 'Save', 'Cancel')
    vi.mocked(pickReviewModel).mockResolvedValue({ kind: 'model', model: { provider: 'test', id: 'review' } })
    run.mocks.getAvailableOfType.mockResolvedValue([])
    await run.command.handler('', run.ctx)
    expect(run.fileSystem.writeFile).not.toHaveBeenCalled()
    expect(run.ui.notify).toHaveBeenCalledWith(expect.stringContaining('no longer available'), 'warning')
  })
  it('show reloads edited files, reports separate origins and typed catalog/auth states without stale active config', async () => {
    const run = setup({ reviewer: 'sys1', sys1_provider: 'test', sys1_model: 'classify', sys2_provider: 'test', sys2_model: 'review' }, { sys1_model: 'project-model' })
    run.sources.set(run.paths.projectPath, JSON.stringify({ reviewer: 'sys2', sys1_model: 'classify', timeoutMs: 4321 }))
    await run.command.handler('show', run.ctx)
    const message = run.ui.notify.mock.calls.at(-1)![0]
    expect(message).toContain('reviewer=sys2 (project)')
    expect(message).toContain('timeoutMs=4321 ms (project)')
    expect(message).toContain('sys1_provider=test (global)')
    expect(message).toContain('sys1_model=classify (project)')
    expect(message).toContain('sys1_availability=available')
    expect(message).toContain('sys2_availability=available')
    expect(run.applyConfig).not.toHaveBeenCalled()
    expect(run.fileSystem.writeFile).not.toHaveBeenCalled()
  })
  it('show diagnoses auth-unavailable vs unknown model without invalidating inactive config', async () => {
    const run = setup({ reviewer: 'sys2', sys1_provider: 'test', sys1_model: 'classify', sys2_provider: 'absent', sys2_model: 'unknown' })
    run.mocks.getAvailableOfType.mockResolvedValue([])
    await run.command.handler('show', run.ctx)
    expect(run.ui.notify.mock.calls.at(-1)![0]).toContain('sys1_availability=unavailable-auth')
    expect(run.ui.notify.mock.calls.at(-1)![0]).toContain('sys2_availability=unknown-model')
  })
  it('refuses malformed layers and missing effective selector; legacy keys are not migrated', async () => {
    const invalid = setup({ use_jev: true })
    invalid.choices('Global')
    await invalid.command.handler('', invalid.ctx)
    expect(invalid.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Fix it manually'), 'error')
    expect(invalid.fileSystem.writeFile).not.toHaveBeenCalled()
    const missing = setup({})
    missing.choices('Project', 'Save', 'Cancel')
    await missing.command.handler('', missing.ctx)
    expect(missing.ui.notify).toHaveBeenCalledWith(expect.stringContaining('reviewer'), 'error')
    expect(missing.fileSystem.writeFile).not.toHaveBeenCalled()
  })
  it('preserves optimistic conflicts and reports saved-but-activation-failed distinctly', async () => {
    const conflict = setup()
    conflict.choices('Project', 'sys2 model:', 'Save', 'Cancel')
    vi.mocked(pickReviewModel).mockImplementation(async () => {
      conflict.sources.set(conflict.paths.projectPath, '{}\n')
      return { kind: 'inherit' }
    })
    await conflict.command.handler('', conflict.ctx)
    expect(conflict.fileSystem.writeFile).not.toHaveBeenCalled()
    expect(conflict.ui.notify).toHaveBeenCalledWith(expect.stringContaining('changed while'), 'error')
    const failure = setup()
    failure.choices('Project', 'Save')
    failure.applyConfig.mockReturnValue({ kind: 'failed', message: 'construction error' } as never)
    await failure.command.handler('', failure.ctx)
    expect(failure.fileSystem.writeFile).toHaveBeenCalledOnce()
    expect(failure.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Config saved, but'), 'error')
  })
})
