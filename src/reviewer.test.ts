import { describe, expect, it, vi } from 'vitest'
import { createPermissionReviewer } from './reviewer.js'
import type { ReviewLog, ReviewPermissionDetails } from './review-types.js'

const config = {
  provider: 'test',
  model: 'review',
  reasoning: 'off' as const,
  timeoutMs: 1_000,
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

function makeReviewer(response: string, providerError = false) {
  const provider = {
    streamSimple: vi.fn(() => ({
      result: async () => {
        if (providerError) {
          throw new Error('provider unavailable')
        }
        return {
          content: [{ type: 'text', text: response }],
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

  it('escalates provider failures', async () => {
    const { authorize } = makeReviewer('', true)

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'escalate' })
  })
})
