import { describe, expect, it, vi } from 'vitest'
import { createPermissionReviewer } from './reviewer.js'
import type { ReviewLog, ReviewPermissionDetails } from './review-types.js'

const config = {
  provider: 'test',
  model: 'review',
  reasoning: 'off' as const,
  timeoutMs: 1_000,
  includeBaselinePolicy: true,
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

describe('standalone reviewer outcomes', () => {
  it('maps model allow to allow', async () => {
    const { authorize } = makeReviewer('{"outcome":"allow"}')

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'allow' })
  })

  it('maps model redirect to a redirect instruction', async () => {
    const { authorize } = makeReviewer('{"outcome":"redirect","redirect":"Use one file.","rationale":"Scope is broad."}')

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'redirect', message: 'Use one file.' })
  })

  it('maps model escalation to escalation with prompt context', async () => {
    const request = details()
    const { authorize } = makeReviewer('{"outcome":"escalate","rationale":"This is destructive."}')

    await expect(authorize(request, makeLog())).resolves.toEqual({ kind: 'escalate' })
    expect(request.message).toContain('This is destructive.')
  })

  it('escalates provider failures', async () => {
    const { authorize } = makeReviewer('', true)

    await expect(authorize(details(), makeLog())).resolves.toEqual({ kind: 'escalate' })
  })
})
