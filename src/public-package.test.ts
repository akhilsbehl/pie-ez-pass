import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import permissionAutoReviewExtension, * as publicPackage from '../dist/pie-ez-pass.mjs'

const CONFIRMATION_EVENT = 'pie-ez-pass:permission-confirmation:v1'

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
  // Hermetic config: never read the developer's live config or call a real reviewer.
  beforeEach(() => {
    const agentDir = mkdtempSync(join(tmpdir(), 'ez-pass-public-'))
    const configDir = join(agentDir, 'extensions', 'pie-ez-pass')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ sys2_provider: 'no-such-provider', sys2_model: 'no-such-model', reviewer: 'sys2' }),
    )
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('publishes only canonical config defaults and rejects obsolete API fields', () => {
    expect(publicPackage.DEFAULT_TIMEOUT_MS).toBe(30000)
    expect(publicPackage.DEFAULT_SYS1_ESCALATE_THRESHOLD).toBe(0.6)
    expect(publicPackage.autoReviewConfigSchema.safeParse({ reviewer: 'sys1' }).success).toBe(true)
    expect(publicPackage.autoReviewConfigSchema.safeParse({ use_jev: true }).success).toBe(false)
    expect(publicPackage).not.toHaveProperty('DEFAULT_JEV_ESCALATE_CONFIDENCE_THRESHOLD')
    expect(publicPackage).not.toHaveProperty('DEFAULT_PROVIDER')
    expect(publicPackage).not.toHaveProperty('DEFAULT_MODEL')
  })

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
