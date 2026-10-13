import type { Api, AssistantMessage, ClassifierApi, ClassifierModel, ClassifierResult, Model } from '@earendil-works/pi-ai'
import { vi } from 'vitest'
import { autoReviewConfigSchema } from './config.js'
import type { ReviewPath } from './config.js'
import type { ReviewModelRegistry } from './model.js'
import type { ReviewPermissionDetails } from './review-types.js'

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const base = { provider: 'test', name: 'Test reviewer', baseUrl: 'https://unused.invalid', input: ['text'] as ['text'], cost, contextWindow: 32_000 }
export const chatModel: Model<Api> = { ...base, id: 'review', api: 'openai-completions', reasoning: true, maxTokens: 1024 }
export const classifierModel: ClassifierModel<ClassifierApi> = { ...base, id: 'classify', api: 'typesafe-system-one', type: 'classifier' }
export const testConfig = (reviewer: ReviewPath = 'sys2', extra = {}) => autoReviewConfigSchema.parse({
  reviewer, sys1_provider: 'test', sys1_model: 'classify', sys2_provider: 'test', sys2_model: 'review',
  sys2_reasoning: 'off', timeoutMs: 2_000, ...extra,
})
export const requestDetails = (): ReviewPermissionDetails => ({
  requestId: 'request-1', source: 'tool_call', message: 'Permission requested for bash.', toolCallId: 'request-1',
  toolName: 'bash', command: 'printf hello', toolInputPreview: '{"command":"printf hello"}', surface: 'bash', value: 'printf hello',
})
export const nativeAnswer = (choice = 'ACCEPT', pEscalate = 0.1, confidence = 0.8): ClassifierResult => ({
  provider: 'test', model: 'classify', api: 'typesafe-system-one', timestamp: 0, stopReason: 'stop', answers: {
    permission_decision: { type: 'choice', choice, probabilities: { ACCEPT: 1 - pEscalate, ESCALATE: pEscalate }, confidence },
  },
})
export const chatReply = (text = '{"outcome":"ACCEPT","rationale":"Routine."}'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'test', model: 'review',
  timestamp: 0, stopReason: 'stop', usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
})

export function fakeRegistry() {
  const mocks = {
    findOfType: vi.fn(() => classifierModel),
    getModelsOfType: vi.fn((type: string) => type === 'classifier' ? [classifierModel] : [chatModel]),
    getAvailableOfType: vi.fn(async (type: string) => type === 'classifier' ? [classifierModel] : [chatModel]),
    classify: vi.fn(async () => nativeAnswer()),
    streamSimple: vi.fn(() => ({ result: async () => chatReply() })),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
  }
  return { registry: mocks as unknown as ReviewModelRegistry, mocks }
}
