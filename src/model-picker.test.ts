import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { ReviewModelPicker, searchReviewModels } from './model-picker.js'
import { fakeRegistry, chatModel, classifierModel } from './reviewer-test-fixtures.js'
import { availableReviewModels, modelAvailability, resolveSys2Model, withCodexAlias } from './model.js'

const current = { provider: 'test', id: 'review' }
const inherited = { provider: 'global', id: 'reviewer/with/slash' }
afterEach(() => vi.useRealTimers())
function setup(path: 'sys1' | 'sys2' = 'sys2', keys = new KeybindingsManager(TUI_KEYBINDINGS)) {
  vi.useFakeTimers()
  const { registry, mocks } = fakeRegistry()
  const done = vi.fn()
  let color = ''
  const theme = { fg: (_name: string, text: string) => `${color}${text}` } as Theme
  const picker = new ReviewModelPicker({ requestRender: vi.fn() }, theme, keys, registry, path, current, inherited, done)
  return { picker, done, mocks, setColor: (value: string) => { color = value } }
}

describe('model identity, search and Codex availability', () => {
  const models = [chatModel, { ...chatModel, provider: 'proxy', id: 'test/review', name: '代理 👩‍💻' }, { ...chatModel, provider: 'second', name: 'Other' }]
  it('searches provider, slash-containing model IDs and Unicode display names without splitting identities', () => {
    expect(searchReviewModels(models, '', { provider: 'second', id: 'review' })[0]?.provider).toBe('second')
    expect(searchReviewModels(models, 'proxy/test/review', current)).toHaveLength(1)
    expect(searchReviewModels(models, '代理', current)[0]?.provider).toBe('proxy')
    expect(searchReviewModels(models, 'second', current)[0]?.provider).toBe('second')
  })
  it('lists Codex hidden alias only with an authenticated compatible template, retaining real-entry precedence', async () => {
    const { registry, mocks } = fakeRegistry()
    const template = { ...chatModel, provider: 'openai-codex', api: 'openai-codex-responses' }
    mocks.getModelsOfType.mockReturnValue([template])
    mocks.getAvailableOfType.mockResolvedValue([template])
    const identity = { provider: 'openai-codex', id: 'codex-auto-review' }
    expect(resolveSys2Model(registry, identity)).toMatchObject({ id: identity.id, reasoning: true, input: ['text'] })
    expect(await modelAvailability(registry, 'sys2', identity, new AbortController().signal)).toBe('available-hidden-alias')
    expect((await availableReviewModels(registry, 'sys2', new AbortController().signal)).map(model => model.id)).toContain(identity.id)
    mocks.getAvailableOfType.mockResolvedValue([])
    expect(await modelAvailability(registry, 'sys2', identity, new AbortController().signal)).toBe('unavailable-auth')
    expect(await availableReviewModels(registry, 'sys2', new AbortController().signal)).toEqual([])
    expect(withCodexAlias([{ ...template, api: 'openai-completions' }])).toHaveLength(1)
    const real = { ...template, id: identity.id, name: 'real', reasoning: false }
    expect(withCodexAlias([template, real]).find(model => model.id === identity.id)).toBe(real)
  })
})

describe('public TUI picker', () => {
  it.each(['sys1', 'sys2'] as const)('refreshes and queries operation-auth-filtered %s choices', async path => {
    const { picker, mocks } = setup(path)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.refresh).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(mocks.getAvailableOfType).toHaveBeenCalledWith(path === 'sys1' ? 'classifier' : 'chat', undefined, { signal: expect.any(AbortSignal) })
    expect(picker.render(120).join('\n')).toContain(path === 'sys1' ? 'classify [test]' : 'review [test]')
    picker.dispose()
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.streamSimple).not.toHaveBeenCalled()
  })
  it('selects the current pair, rechecks authentication and returns separate identity fields', async () => {
    const { picker, mocks, done } = setup()
    await vi.advanceTimersByTimeAsync(0)
    picker.handleInput('\r'); await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledWith({ kind: 'model', model: current })
    expect(mocks.getAvailableOfType).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the authenticated hidden Codex alias as a searchable selectable option', async () => {
    const { picker, mocks, done } = setup()
    mocks.getAvailableOfType.mockResolvedValue([{ ...chatModel, provider: 'openai-codex', api: 'openai-codex-responses' }])
    await vi.advanceTimersByTimeAsync(0)
    picker.handleInput('codex-auto-review')
    expect(picker.render(180).join('\n')).toContain('codex-auto-review [openai-codex]')
    picker.handleInput('\r'); await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledWith({ kind: 'model', model: { provider: 'openai-codex', id: 'codex-auto-review' } })
  })
  it('query changes highlight top fuzzy match and wrap navigation keeps Inherit reachable', async () => {
    const { picker, mocks, done } = setup()
    mocks.getAvailableOfType.mockResolvedValue([chatModel, { ...chatModel, provider: 'other', id: 'review/slash' }])
    await vi.advanceTimersByTimeAsync(0)
    picker.handleInput('other/review/slash')
    picker.handleInput('\r'); await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledWith({ kind: 'model', model: { provider: 'other', id: 'review/slash' } })
  })
  it('Inherit survives a nonmatching query and is reachable via configured tab action', async () => {
    const { picker, done } = setup()
    await vi.advanceTimersByTimeAsync(0)
    picker.handleInput('NO MATCH ANYWHERE')
    expect(picker.render(120).join('\n')).toContain('No search matches')
    picker.handleInput('\t'); picker.handleInput('\r')
    expect(done).toHaveBeenCalledWith({ kind: 'inherit' })
  })
  it('up wraps to Inherit, down wraps back to the first model', async () => {
    const { picker, done } = setup()
    await vi.advanceTimersByTimeAsync(0)
    picker.handleInput('\x1b[A'); picker.handleInput('\x1b[B'); picker.handleInput('\r')
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledWith({ kind: 'model', model: current })
  })
  it('keeps an unavailable configured value as status, not a selectable row', async () => {
    const { picker, mocks } = setup()
    mocks.getAvailableOfType.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(0)
    const output = picker.render(160).join('\n')
    expect(output).toContain('Configured: test/review (unavailable; not selectable)')
    expect(output).toContain('No authenticated models of this type. Use /login')
    expect(output).not.toContain('review [test]')
    picker.dispose()
  })
  it('rejects a selection auth race without changing config', async () => {
    const { picker, mocks, done } = setup()
    await vi.advanceTimersByTimeAsync(0)
    mocks.getAvailableOfType.mockResolvedValue([])
    picker.handleInput('\r'); await vi.advanceTimersByTimeAsync(0)
    expect(done).not.toHaveBeenCalled()
    expect(picker.render(160).join('\n')).toContain('no longer available')
    picker.dispose()
  })
  it('cancel is configurable, aborts uncooperative refresh and prevents late completion', async () => {
    const { picker, mocks, done } = setup('sys2', new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.select.cancel': 'ctrl+q' }))
    let finish!: (models: any) => void
    mocks.getAvailableOfType.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    const signal = (mocks.refresh.mock.calls[0] as any[])[0].signal as AbortSignal
    picker.handleInput('\x11')
    expect(done).toHaveBeenCalledWith(undefined)
    expect(signal.aborted).toBe(true)
    finish([chatModel]); await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds refresh at 15 seconds, and retains Inherit/cancel without an auth snapshot', async () => {
    const { picker, mocks } = setup()
    mocks.getAvailableOfType.mockImplementation(async () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(15000)
    expect(picker.render(160).join('\n')).toContain('discovery timed out')
    expect(picker.render(160).join('\n')).toContain('Use inherited model pair')
    expect(vi.getTimerCount()).toBe(0)
    picker.dispose()
  })
  it('reports refresh errors and uses only auth-checked cached catalog rows', async () => {
    const { picker, mocks } = setup()
    mocks.refresh.mockResolvedValue({ aborted: false, errors: new Map([['test', new Error('offline')]]) })
    // Constructor awaits the returned promise; adjust its result before the next microtask.
    picker.dispose()
    const second = new ReviewModelPicker({ requestRender: vi.fn() }, { fg: (_: string, s: string) => s } as Theme, new KeybindingsManager(TUI_KEYBINDINGS), mocks as never, 'sys2', current, inherited, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(second.render(160).join('\n')).toContain('using cached catalog')
    expect(second.render(160).join('\n')).toContain('review [test]')
    second.dispose()
  })
  it('fits narrow/resized Unicode views, propagates focus, invalidates theme, and uses no fullscreen-only input', async () => {
    const { picker, mocks, setColor } = setup()
    mocks.getAvailableOfType.mockResolvedValue([{ ...classifierModel, provider: '👩‍💻', id: '界/判定' }])
    await vi.advanceTimersByTimeAsync(0)
    picker.focused = true; expect(picker.input.focused).toBe(true)
    for (const width of [0, 1, 10, 30, 100, 20]) expect(picker.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    const before = picker.render(100)
    setColor('\x1b[31m'); picker.invalidate()
    expect(picker.render(100)).not.toEqual(before)
    picker.focused = false; expect(picker.input.focused).toBe(false)
    picker.dispose()
  })
})
