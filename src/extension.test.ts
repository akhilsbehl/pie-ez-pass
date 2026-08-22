import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import { createAutoReviewExtension } from './extension.js'

type Handler = (...args: unknown[]) => unknown

function makePi() {
  const handlers = new Map<string, Handler>()
  const eventHandlers = new Map<string, Handler>()
  return {
    handlers,
    eventHandlers,
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    events: {
      on: vi.fn((event: string, handler: Handler) => eventHandlers.set(event, handler)),
    },
    registerCommand: vi.fn(),
  }
}

function makeService() {
  let authorize: unknown
  const dispose = vi.fn(() => {
    authorize = undefined
  })
  return {
    registerAuthorizer: vi.fn((_: string, next: unknown) => {
      authorize = next
      return dispose
    }),
    dispose,
    get authorize() {
      return authorize
    },
  }
}

describe('permission-service replacement', () => {
  it('re-registers the reviewer when the permission service is replaced', () => {
    const pi = makePi()
    const firstService = makeService()
    const replacementService = makeService()
    let activeService: typeof firstService | undefined = firstService

    createAutoReviewExtension(pi as never, {
      loadConfig: () => ({ config: undefined, issues: [], globalPath: '', projectPath: '' }),
      getPermissionsService: () => activeService as never,
    })

    pi.handlers.get('session_start')?.({ }, {
      cwd: '/tmp/project',
      modelRegistry: {} as never,
      sessionManager: { buildContextEntries: vi.fn() },
    })
    expect(firstService.registerAuthorizer).toHaveBeenCalledTimes(1)
    expect(firstService.authorize).toBeDefined()

    activeService = replacementService
    pi.eventHandlers.get(PERMISSIONS_READY_CHANNEL)?.()

    expect(firstService.dispose).toHaveBeenCalledTimes(1)
    expect(firstService.authorize).toBeUndefined()
    expect(replacementService.registerAuthorizer).toHaveBeenCalledTimes(1)
    expect(replacementService.authorize).toBeDefined()
  })
})
