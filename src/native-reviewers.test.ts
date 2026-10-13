import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSys1Reviewer } from './sys1-reviewer.js'
import { createSys2Reviewer } from './sys2-reviewer.js'
import { fakeRegistry, testConfig, requestDetails, chatReply, nativeAnswer, classifierModel } from './reviewer-test-fixtures.js'

const log = () => ({ review: vi.fn(), debug: vi.fn() })
afterEach(() => vi.useRealTimers())

describe.each(['sys1', 'sys2'] as const)('%s native reviewer boundary', path => {
  function setup(extra = {}, sessionSignal?: AbortSignal, sleep?: (ms: number, signal: AbortSignal) => Promise<void>) {
    const { registry, mocks } = fakeRegistry()
    const runtime = { config: testConfig(path, extra), registry, sessionManager: { buildContextEntries: () => [] }, ...(sessionSignal ? { sessionSignal } : {}) }
    const reviewer = path === 'sys1' ? createSys1Reviewer(runtime, sleep ? { sleep } : {}) : createSys2Reviewer(runtime, sleep ? { sleep } : {})
    return { reviewer, mocks }
  }
  it('dispatches only the configured native operation with zero provider retries', async () => {
    const { reviewer, mocks } = setup()
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'accept' })
    const calls = path === 'sys1' ? mocks.classify : mocks.streamSimple
    expect(calls).toHaveBeenCalledOnce()
    const options = (calls.mock.calls[0] as unknown[])[2] as any
    expect(options).toMatchObject({ maxRetries: 0, timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) })
    expect(options.timeoutMs).toBeLessThanOrEqual(2000)
    expect(options).not.toHaveProperty('apiKey')
    expect(path === 'sys1' ? mocks.streamSimple : mocks.classify).not.toHaveBeenCalled()
    expect(mocks.getAvailableOfType).toHaveBeenCalledWith(path === 'sys1' ? 'classifier' : 'chat', 'test', { signal: expect.any(AbortSignal) })
    if (path === 'sys2') expect(options.maxTokens).toBe(256)
    else {
      const context = (calls.mock.calls[0] as unknown[])[1] as any
      expect(context.state.permissionReviewState).toContain('Strongly default to ACCEPT')
      expect(context.state.permissionReviewState).toContain('Native output contract')
      expect(context.state).not.toHaveProperty('images')
      expect(context.questions.permission_decision).toEqual({
        type: 'choice', instructions: 'Under the trusted policy and supplied evidence, choose the permission outcome for the exact bash action.',
        criteria: { ACCEPT: 'The action is safe to run without human approval under the policy.', ESCALATE: 'The action requires a human decision under the policy.' },
      })
    }
  })
  it('owns three provider attempts and shared 250/1000ms backoffs', async () => {
    vi.useFakeTimers()
    const { reviewer, mocks } = setup()
    if (path === 'sys1') mocks.classify.mockRejectedValue(new Error('down'))
    else mocks.streamSimple.mockImplementation(() => ({ result: async () => { throw new Error('down') } }))
    const reviewLog = log()
    const pending = reviewer(requestDetails(), reviewLog)
    await vi.advanceTimersByTimeAsync(0)
    const calls = path === 'sys1' ? mocks.classify : mocks.streamSimple
    expect(calls).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(249); expect(calls).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(calls).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999); expect(calls).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'escalate' })
    expect(calls).toHaveBeenCalledTimes(3)
    expect(reviewLog.review).toHaveBeenCalledWith('auto_review.decision', expect.objectContaining({ reviewer: path, attempts: 3, errorCategory: 'provider-error' }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['error', 'aborted'] as const)('ignores accepting answers after provider stop=%s', async stopReason => {
    const { reviewer, mocks } = setup({}, undefined, async () => {})
    if (path === 'sys1') mocks.classify.mockResolvedValue({ ...nativeAnswer(), stopReason })
    else mocks.streamSimple.mockReturnValue({ result: async () => ({ ...chatReply(), stopReason }) })
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(path === 'sys1' ? mocks.classify : mocks.streamSimple).toHaveBeenCalledTimes(3)
  })
  it('rechecks auth on new reviews: logout escalates, login recovers without config replacement', async () => {
    const { reviewer, mocks } = setup()
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'accept' })
    mocks.getAvailableOfType.mockResolvedValueOnce([])
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'accept' })
    expect(path === 'sys1' ? mocks.classify : mocks.streamSimple).toHaveBeenCalledTimes(2)
  })
  it.each(['availability', 'request', 'retry-wait'] as const)('hard-bounds an uncooperative %s by total timeout', async phase => {
    vi.useFakeTimers()
    const { reviewer, mocks } = setup({ timeoutMs: 30 }, undefined, phase === 'retry-wait' ? async () => new Promise<void>(() => {}) : undefined)
    if (phase === 'availability') mocks.getAvailableOfType.mockImplementation(async () => new Promise(() => {}))
    else if (path === 'sys1') mocks.classify.mockImplementation(async () => phase === 'retry-wait' ? Promise.reject(new Error('down')) : new Promise(() => {}))
    else mocks.streamSimple.mockReturnValue({ result: async () => phase === 'retry-wait' ? Promise.reject(new Error('down')) : new Promise(() => {}) })
    const reviewLog = log()
    const pending = reviewer(requestDetails(), reviewLog)
    await vi.advanceTimersByTimeAsync(30)
    expect(await pending).toEqual({ kind: 'escalate' })
    expect(reviewLog.review).toHaveBeenCalledWith('auto_review.decision', expect.objectContaining({ errorCategory: 'timeout' }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('generation abort bounds uncooperative requests and prevents retry', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { reviewer, mocks } = setup({}, controller.signal)
    if (path === 'sys1') mocks.classify.mockImplementation(async () => new Promise(() => {}))
    else mocks.streamSimple.mockReturnValue({ result: async () => new Promise(() => {}) })
    const reviewLog = log()
    const pending = reviewer(requestDetails(), reviewLog)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toEqual({ kind: 'escalate' })
    expect(reviewLog.review).toHaveBeenCalledWith('auto_review.decision', expect.objectContaining({ errorCategory: 'cancelled' }))
    expect(path === 'sys1' ? mocks.classify : mocks.streamSimple).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not dispatch a model when generation is already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    const { reviewer, mocks } = setup({}, controller.signal)
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.streamSimple).not.toHaveBeenCalled()
  })
  it('unresolved models escalate without alternate-provider/path selection', async () => {
    const { reviewer, mocks } = setup({ sys1_model: 'absent', sys2_model: 'absent' })
    mocks.findOfType.mockReturnValue(undefined as never)
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.streamSimple).not.toHaveBeenCalled()
  })
})

describe('native sys1 malformed result retries', () => {
  it('retries malformed answers immediately without backoff and accepts a valid subsequent reply', async () => {
    const { registry, mocks } = fakeRegistry()
    mocks.classify.mockResolvedValueOnce({ ...nativeAnswer(), answers: {} }).mockResolvedValueOnce(nativeAnswer('ESCALATE', 0.59, 0.99))
    const sleep = vi.fn(async () => {})
    const reviewer = createSys1Reviewer({ config: testConfig('sys1'), registry, sessionManager: { buildContextEntries: () => [] } }, { sleep })
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'accept' })
    expect(mocks.classify).toHaveBeenCalledTimes(2); expect(sleep).not.toHaveBeenCalled()
  })
  it('fails closed after three malformed answers and rejects wrong-operation model', async () => {
    const { registry, mocks } = fakeRegistry()
    mocks.classify.mockResolvedValue({ ...nativeAnswer(), answers: {} })
    const reviewer = createSys1Reviewer({ config: testConfig('sys1'), registry, sessionManager: { buildContextEntries: () => [] } })
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(mocks.classify).toHaveBeenCalledTimes(3)
    mocks.findOfType.mockReturnValue({ ...classifierModel, type: 'chat' } as never)
    mocks.classify.mockClear()
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'escalate' })
    expect(mocks.classify).not.toHaveBeenCalled()
  })
})

describe('native sys2 output settings', () => {
  it('dispatches the approved hidden alias through native registry streaming, not its template ID', async () => {
    const { registry, mocks } = fakeRegistry()
    const template = { ...((await registry.getAvailableOfType('chat'))[0]!), provider: 'openai-codex', api: 'openai-codex-responses' }
    mocks.getModelsOfType.mockReturnValue([template])
    mocks.getAvailableOfType.mockResolvedValue([template])
    const config = testConfig('sys2', { sys2_provider: 'openai-codex', sys2_model: 'codex-auto-review' })
    expect(await createSys2Reviewer({ config, registry, sessionManager: { buildContextEntries: () => [] } })(requestDetails(), log())).toEqual({ kind: 'accept' })
    expect(mocks.streamSimple).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai-codex', id: 'codex-auto-review', api: 'openai-codex-responses' }), expect.anything(), expect.objectContaining({ maxRetries: 0 }))
  })
  it.each([[true, 'low', true], [true, 'off', false], [false, 'low', false]] as const)('reasoning=%s configured=%s', async (supported, reasoning, sent) => {
    const { registry, mocks } = fakeRegistry()
    const models = await registry.getAvailableOfType('chat')
    mocks.getModelsOfType.mockReturnValue([{ ...models[0]!, reasoning: supported }] as never)
    const reviewer = createSys2Reviewer({ config: testConfig('sys2', { sys2_reasoning: reasoning }), registry, sessionManager: { buildContextEntries: () => [] } })
    expect(await reviewer(requestDetails(), log())).toEqual({ kind: 'accept' })
    const options = (mocks.streamSimple.mock.calls[0] as unknown[])[2] as any
    expect(options.reasoning).toBe(sent ? reasoning : undefined)
  })
  it('displays the complete validated rationale, including beyond 600 characters', async () => {
    const { registry, mocks } = fakeRegistry()
    const rationale = 'x'.repeat(900)
    mocks.streamSimple.mockReturnValue({ result: async () => chatReply(JSON.stringify({ outcome: 'ESCALATE', rationale })) })
    const details = requestDetails()
    expect(await createSys2Reviewer({ config: testConfig(), registry, sessionManager: { buildContextEntries: () => [] } })(details, log())).toEqual({ kind: 'escalate' })
    expect(details.message).toContain(rationale)
    expect(details.message).not.toContain('…')
  })
})
