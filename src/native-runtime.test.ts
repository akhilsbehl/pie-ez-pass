import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import { createSys1Reviewer } from './sys1-reviewer.js'
import { createSys2Reviewer } from './sys2-reviewer.js'
import { chatModel, chatReply, classifierModel, nativeAnswer, requestDetails, testConfig } from './reviewer-test-fixtures.js'

// Real public registry/runtime, fake provider only. No HTTP or live credentials.
describe.each(['sys1', 'sys2'] as const)('%s public Pi runtime integration', path => {
  it('applies native request-time endpoint/header/env/auth and operation filtering without leaking credentials', async () => {
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({
      credentials, modelsPath: null, modelsStorePath: join(mkdtempSync(join(tmpdir(), 'ez-pass-runtime-')), 'models-cache.json'),
      allowModelNetwork: false, refreshOnCreate: false,
    })
    const stream = vi.fn<Provider['streamSimple']>((_model, _context, _options) => {
      const result = chatReply()
      const events = createAssistantMessageEventStream()
      events.push({ type: 'done', reason: 'stop', message: result }); events.end(result)
      return events
    })
    const classify = vi.fn<NonNullable<Provider['classify']>>(async (_model, _context, _options) => nativeAnswer())
    const resolve = vi.fn<NonNullable<Provider['auth']['apiKey']>['resolve']>(async ({ credential }) => credential?.key ? {
      auth: { apiKey: credential.key, baseUrl: 'https://auth-endpoint.invalid', headers: { 'X-Native': 'yes' } },
      env: { REGION: 'fake-region' }, source: 'test',
    } : undefined)
    let classifierAllowed = true
    const provider: Provider = {
      id: 'test', name: 'Test', auth: { apiKey: { name: 'Test key', resolve } },
      getModels: () => [chatModel], getAllModels: () => [chatModel, classifierModel],
      filterAllModels: models => models.filter(model => classifierAllowed || model.type !== 'classifier'),
      stream: () => { throw new Error('full stream must not be called') }, streamSimple: stream, classify,
    }
    runtime.registerNativeProvider(provider)
    await credentials.modify('test', async () => ({ type: 'api_key', key: 'fake-secret-key' }))
    const registry = new ModelRegistry(runtime)
    const log = { review: vi.fn(), debug: vi.fn() }
    const reviewerRuntime = { config: testConfig(path), registry, sessionManager: { buildContextEntries: () => [] } }
    const reviewer = path === 'sys1' ? createSys1Reviewer(reviewerRuntime) : createSys2Reviewer(reviewerRuntime)
    expect(await reviewer(requestDetails(), log)).toEqual({ kind: 'accept' })
    const call = (path === 'sys1' ? classify : stream).mock.calls[0]! as any[]
    expect(call[0]).toMatchObject({ baseUrl: 'https://auth-endpoint.invalid' })
    expect(call[2]).toMatchObject({ apiKey: 'fake-secret-key', headers: { 'X-Native': 'yes' }, env: { REGION: 'fake-region' }, maxRetries: 0 })
    if (path === 'sys2') expect(call[1].messages[0].role).toBe('system')
    expect(JSON.stringify(log.review.mock.calls)).not.toContain('fake-secret-key')
    await credentials.delete('test')
    expect(await reviewer(requestDetails(), log)).toEqual({ kind: 'escalate' })
    await credentials.modify('test', async () => ({ type: 'api_key', key: 'new-fake-secret' }))
    if (path === 'sys1') {
      classifierAllowed = false
      expect(await reviewer(requestDetails(), log)).toEqual({ kind: 'escalate' })
      classifierAllowed = true
    }
    expect(await reviewer(requestDetails(), log)).toEqual({ kind: 'accept' })
    expect((path === 'sys1' ? classify : stream).mock.calls.at(-1)![2]).toMatchObject({ apiKey: 'new-fake-secret' })
  })
})
