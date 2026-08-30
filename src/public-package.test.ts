import { describe, expect, it, vi } from 'vitest'
import permissionAutoReviewExtension from '../dist/pie-permission-auto-review-codex.mjs'

const CONFIRMATION_EVENT = 'pie-permission-auto-review-codex:permission-confirmation:v1'

type Handler = (...args: any[]) => any

function loadPublicExtension() {
  const handlers = new Map<string, Handler>()
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerCommand: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  }
  permissionAutoReviewExtension(pi as never)

  const context = {
    cwd: '/workspace/project-without-auto-review-config',
    modelRegistry: {},
    sessionManager: { buildContextEntries: () => [] },
    hasUI: true,
    ui: { confirm: vi.fn(async () => true) },
  }
  handlers.get('session_start')?.({}, context)
  return { context, handlers, pi }
}

describe('public package permission-confirmation boundary', () => {
  it('brackets public-entrypoint confirmation with the exact request-scoped lifecycle event', async () => {
    const { context, handlers, pi } = loadPublicExtension()
    context.ui.confirm.mockImplementation(async () => {
      expect(pi.events.emit).toHaveBeenLastCalledWith(CONFIRMATION_EVENT, {
        requestId: 'public-call-1',
        active: true,
      })
      return true
    })

    const result = await handlers.get('tool_call')?.(
      {
        type: 'tool_call',
        toolCallId: 'public-call-1',
        toolName: 'bash',
        input: { command: 'touch /important' },
      },
      context,
    )

    expect(result).toEqual({})
    expect(context.ui.confirm).toHaveBeenCalledOnce()
    expect(pi.events.emit.mock.calls).toEqual([
      [CONFIRMATION_EVENT, { requestId: 'public-call-1', active: true }],
      [CONFIRMATION_EVENT, { requestId: 'public-call-1', active: false }],
    ])
  })
})
