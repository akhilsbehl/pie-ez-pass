import { describe, expect, it, vi } from 'vitest'
import type { LoadConfigResult } from './config.js'
import { createAutoReviewExtension } from './extension.js'

type Handler = (...args: any[]) => unknown

type Verdict = 'allow' | 'redirect' | 'escalate'

function makePi() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerCommand: vi.fn(),
  }
}

function makeContext(confirm: boolean) {
  return {
    cwd: '/tmp/project',
    modelRegistry: {} as never,
    sessionManager: { buildContextEntries: vi.fn(() => []) },
    hasUI: true,
    ui: { confirm: vi.fn(async () => confirm) },
  }
}

const validConfig = {
  provider: 'test',
  model: 'review',
  reasoning: 'off' as const,
  timeoutMs: 1_000,
  includeBaselinePolicy: true,
}

function startExtension(
  verdict: Verdict,
  loadConfig: () => LoadConfigResult = () => ({ config: validConfig, issues: [], globalPath: '', projectPath: '' }),
) {
  const pi = makePi()
  const reviewer = vi.fn(async () =>
    verdict === 'redirect' ? { kind: 'redirect' as const, message: 'Use one file at a time.' } : { kind: verdict },
  )
  createAutoReviewExtension(pi as never, {
    loadConfig,
    createReviewer: () => reviewer,
  })
  pi.handlers.get('session_start')?.({}, makeContext(true))
  return { pi, reviewer }
}

const toolCall = {
  type: 'tool_call',
  toolCallId: 'request-1',
  toolName: 'bash',
  input: { command: 'printf hello' },
}

describe('standalone tool-call permission boundary', () => {
  it('allows a reviewer allow without prompting or logging', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { pi, reviewer } = startExtension('allow')
      const context = makeContext(false)

      const result = await pi.handlers.get('tool_call')?.(toolCall, context)

      expect(result).toEqual({})
      expect(reviewer).toHaveBeenCalledTimes(1)
      expect(context.ui.confirm).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
      warn.mockRestore()
    }
  })

  it('does not review tools outside the edit and bash boundary', async () => {
    const { pi, reviewer } = startExtension('escalate')
    const context = makeContext(false)

    const result = await pi.handlers.get('tool_call')?.({ ...toolCall, toolName: 'read' }, context)

    expect(result).toEqual({})
    expect(reviewer).not.toHaveBeenCalled()
    expect(context.ui.confirm).not.toHaveBeenCalled()
  })

  it('redirects the main model with a narrower instruction', async () => {
    const { pi, reviewer } = startExtension('redirect')
    const context = makeContext(false)

    const result = await pi.handlers.get('tool_call')?.(toolCall, context)

    expect(result).toEqual({
      block: true,
      reason: 'Automatic review requires a narrower action: Use one file at a time.',
    })
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(context.ui.confirm).not.toHaveBeenCalled()
  })

  it('escalates after the fourth redirect in one turn', async () => {
    const { pi } = startExtension('redirect')
    const context = makeContext(true)
    const handler = pi.handlers.get('tool_call')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handler?.({ ...toolCall, toolCallId: `request-${attempt}` }, context)
    }
    const result = await handler?.({ ...toolCall, toolCallId: 'request-4' }, context)

    expect(result).toEqual({})
    expect(context.ui.confirm).toHaveBeenCalledTimes(1)
    expect(context.ui.confirm).toHaveBeenCalledWith('Permission escalation', expect.stringContaining('bash'))
  })

  it('turns escalation into the standalone user confirmation', async () => {
    const { pi } = startExtension('escalate')
    const context = makeContext(true)

    const result = await pi.handlers.get('tool_call')?.(toolCall, context)

    expect(result).toEqual({})
    expect(context.ui.confirm).toHaveBeenCalledWith('Permission escalation', expect.stringContaining('bash'))
  })

  it('blocks when the user rejects escalation', async () => {
    const { pi } = startExtension('escalate')
    const context = makeContext(false)

    const result = await pi.handlers.get('tool_call')?.(toolCall, context)

    expect(result).toEqual({ block: true, reason: 'Permission denied by user.' })
  })

  it('fails closed when escalation has no UI', async () => {
    const { pi } = startExtension('escalate')
    const context = makeContext(true)
    context.hasUI = false

    const result = await pi.handlers.get('tool_call')?.(toolCall, context)

    expect(result).toEqual({
      block: true,
      reason: 'Automatic review could not obtain user confirmation in this Pi mode.',
    })
  })

  it('fails closed when the configuration is invalid', async () => {
    const { pi, reviewer } = startExtension('allow', () => ({ config: undefined, issues: [], globalPath: '', projectPath: '' }))
    const context = makeContext(true)

    const result = await pi.handlers.get('tool_call')?.(toolCall, context)

    expect(result).toEqual({
      block: true,
      reason: 'Automatic permission review is unavailable because its configuration is invalid.',
    })
    expect(reviewer).not.toHaveBeenCalled()
  })
})
