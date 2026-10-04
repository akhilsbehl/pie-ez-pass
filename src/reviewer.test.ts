import { describe, expect, it, vi } from 'vitest'
import { createPermissionReviewer } from './reviewer.js'
import type { ReviewLog, ReviewPermissionDetails } from './review-types.js'

const config = {
  provider: 'test',
  model: 'review',
  reasoning: 'off' as const,
  timeoutMs: 1_000,
  use_jev: false,
  jev_escalate_confidence_threshold: 0.6,
}

const details = (): ReviewPermissionDetails => ({
  requestId: 'request-1',
  source: 'tool_call',
  message: 'Permission requested for bash.',
  toolCallId: 'request-1',
  toolName: 'bash',
  command: 'printf hello',
  toolInputPreview: '{"command":"printf hello"}',
  surface: 'bash',
  value: 'printf hello',
})

function makeLog(): ReviewLog {
  return { review: vi.fn(), debug: vi.fn() }
}

function makeReviewer(response: string | string[], providerError = false) {
  const responses = Array.isArray(response) ? [...response] : undefined
  const provider = {
    streamSimple: vi.fn(() => ({
      result: async () => {
        if (providerError) {
          throw new Error('provider unavailable')
        }
        return {
          content: [{ type: 'text', text: responses ? (responses.length > 1 ? responses.shift() : responses[0]) : response }],
          stopReason: 'stop',
        }
      },
    })),
  }
  const model = { provider: 'test', id: 'review', api: 'test', reasoning: false, input: ['text'] }
  const registry = {
    getProvider: () => provider,
    find: () => model,
    getAll: () => [model],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test' }),
  }
  const authorize = createPermissionReviewer({
    config,
    registry: registry as never,
    sessionManager: { buildContextEntries: () => [] },
  })
  return { authorize, provider }
}

describe('reviewer outcomes', () => {
  it('maps model ACCEPT to accept', async () => {
    const { authorize } = makeReviewer('{"outcome":"ACCEPT","rationale":"Routine."}')

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'accept' })
  })

  it('maps model escalation to escalation with prompt context', async () => {
    const request = details()
    const { authorize } = makeReviewer('{"outcome":"ESCALATE","rationale":"This is destructive."}')

    await expect(authorize(request, makeLog())).resolves.toEqual({ kind: 'escalate' })
    expect(request.message).toContain('This is destructive.')
  })

  it('retries when the first response is prose and accepts a later JSON reply', async () => {
    const { authorize, provider } = makeReviewer(['Approve — harmless.', '{"outcome":"ACCEPT","rationale":"Routine."}'])

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'accept' })
    expect(provider.streamSimple).toHaveBeenCalledTimes(2)
  })

  it('logs the attempt count on success so recoveries are visible', async () => {
    const log = makeLog()
    const { authorize } = makeReviewer(['Approve.', '{"outcome":"ACCEPT","rationale":"ok"}'])

    await authorize(details(), log)
    expect(log.review).toHaveBeenCalledWith('auto_review.decision', expect.objectContaining({ outcome: 'ACCEPT', attempts: 2 }))
  })

  it('feeds the rejected reply and the problem back on retry', async () => {
    const { authorize, provider } = makeReviewer(['Approve — harmless.', '{"outcome":"ACCEPT","rationale":"Routine."}'])

    await authorize(details(), makeLog())
    const second = (provider.streamSimple.mock.calls[1] as unknown[])[1] as { messages: { content: string }[] }
    const content = second.messages[0]!.content
    expect(content).toContain('Approve — harmless.')
    expect(content).toContain('did not contain a JSON object')
  })

  it('names the offending field when JSON has the wrong shape', async () => {
    const { authorize, provider } = makeReviewer(['{"outcome":"APPROVE","rationale":"ok"}', '{"outcome":"ACCEPT","rationale":"ok"}'])

    await authorize(details(), makeLog())
    const second = (provider.streamSimple.mock.calls[1] as unknown[])[1] as { messages: { content: string }[] }
    expect(second.messages[0]!.content).toContain('outcome:')
  })

  it('ends the user prompt with the JSON output reminder', async () => {
    const { authorize, provider } = makeReviewer('{"outcome":"ACCEPT","rationale":"ok"}')
    await authorize(details(), makeLog())
    const ctx = (provider.streamSimple.mock.calls[0] as unknown[])[1] as { messages: { content: string }[] }
    expect(ctx.messages[0]!.content.trimEnd()).toMatch(/"outcome": "ACCEPT" \| "ESCALATE"[^]*\}$/)
  })

  it('escalates provider failures', async () => {
    const { authorize } = makeReviewer('', true)

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'escalate' })
  })

  it('records response and parser diagnostics for invalid model output', async () => {
    const log = makeLog()
    const { authorize } = makeReviewer('not-json')

    await expect(authorize(details(), log)).resolves.toEqual({ kind: 'escalate' })
    expect(log.review).toHaveBeenCalledWith(
      'auto_review.decision',
      expect.objectContaining({
        errorCategory: 'invalid-response',
        failurePhase: 'response-parse',
        errorMessage: expect.stringContaining('JSON'),
        responsePreview: 'not-json',
        responseBlockTypes: 'text',
        attempts: 3,
        stopReason: 'stop',
      }),
    )
  })
})
