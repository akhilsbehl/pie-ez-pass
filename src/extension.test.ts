import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewLog } from './review-types.js'
import { DEFAULT_RULES } from './config.js'
import { createAutoReviewExtension } from './extension.js'

function setup(kind: 'accept' | 'escalate', options: { valid?: boolean; throws?: boolean; hasUI?: boolean; approved?: boolean; rules?: typeof DEFAULT_RULES } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const pi = { on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)), registerCommand: vi.fn() }
  const reviewer = vi.fn(async () => { if (options.throws) throw new Error('provider failed'); return { kind } })
  const reviewLog: ReviewLog = { review: vi.fn(), debug: vi.fn() }
  createAutoReviewExtension(pi as never, {
    loadConfig: () => ({ config: options.valid === false ? undefined : { provider: 'test', model: 'review', reasoning: 'off', timeoutMs: 1000, rules: options.rules ?? DEFAULT_RULES }, issues: [], globalPath: '', projectPath: '' }),
    createReviewer: () => reviewer, reviewLog,
  })
  const context = { cwd: '/workspace/project', modelRegistry: {}, sessionManager: { buildContextEntries: () => [] }, hasUI: options.hasUI ?? true, ui: { confirm: vi.fn(async () => options.approved ?? true) } }
  handlers.get('session_start')?.({}, context)
  return { handlers, reviewer, reviewLog, context }
}
const call = { type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: { command: 'touch /important' } }

describe('tool_call permission boundary', () => {
  it.each(['edit', 'write'] as const)('accepts %s targets in session CWD without review', async toolName => {
    const { handlers, context, reviewer } = setup('escalate')
    expect(await handlers.get('tool_call')?.({ ...call, toolName, input: { path: '/workspace/project/src/a', content: 'x' } }, context)).toEqual({})
    expect(reviewer).not.toHaveBeenCalled()
  })
  it.each(['/tmp/a', `${homedir()}/tmp/a`, `${homedir()}/.richie/a`, `${homedir()}/.pi/a`, `${homedir()}/warchives/a`])('deterministically accepts %s', async path => {
    const { handlers, context, reviewer } = setup('escalate')
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path, content: 'x' } }, context)).toEqual({})
    expect(reviewer).not.toHaveBeenCalled()
  })
  it('resolves relative paths against session-start CWD', async () => {
    const { handlers, context, reviewer } = setup('escalate'); context.cwd = '/changed'
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path: 'src/a', content: 'x' } }, context)).toEqual({})
    expect(reviewer).not.toHaveBeenCalled()
  })

  it.each(['~', '~/tmp/a'])('expands tilde-form write target %s before allow matching', async path => {
    const rules = { allow: { commands: [], paths: ['~'] }, block: { commands: [], paths: [] } } as typeof DEFAULT_RULES
    const { handlers, context, reviewer } = setup('escalate', { rules })
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path, content: 'x' } }, context)).toEqual({})
    expect(reviewer).not.toHaveBeenCalled()
  })

  it('expands tilde-form edit targets before block matching', async () => {
    const rules = { allow: { commands: [], paths: [] }, block: { commands: [], paths: ['~/private'] } } as unknown as typeof DEFAULT_RULES
    const { handlers, context, reviewer } = setup('accept', { rules })
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'edit', input: { path: '~/private/a' } }, context)).toMatchObject({ block: true })
    expect(reviewer).not.toHaveBeenCalled()
  })
  it('applies anchored command allow, block, and overlap decisions before model review', async () => {
    const rules = { allow: { commands: ['git show *', '*--version'], paths: [] }, block: { commands: ['git show secret*', 'sudo *'], paths: [] } } as typeof DEFAULT_RULES
    const allowed = setup('escalate', { rules }); expect(await allowed.handlers.get('tool_call')?.({ ...call, input: { command: ' git show HEAD ' } }, allowed.context)).toEqual({}); expect(allowed.reviewer).not.toHaveBeenCalled()
    const blocked = setup('accept', { rules }); expect(await blocked.handlers.get('tool_call')?.({ ...call, input: { command: 'sudo echo no' } }, blocked.context)).toMatchObject({ block: true }); expect(blocked.reviewer).not.toHaveBeenCalled()
    const conflict = setup('accept', { rules, approved: false }); expect(await conflict.handlers.get('tool_call')?.({ ...call, input: { command: 'git show secret-file' } }, conflict.context)).toMatchObject({ block: true }); expect(conflict.context.ui.confirm).toHaveBeenCalledOnce()
    const anchored = setup('escalate', { rules, approved: false }); expect(await anchored.handlers.get('tool_call')?.({ ...call, input: { command: 'echo git show HEAD' } }, anchored.context)).toMatchObject({ block: true }); expect(anchored.reviewer).toHaveBeenCalledOnce()
  })

  it('uses only explicit paths and lets a narrower block win', async () => {
    const rules = { allow: { commands: [], paths: ['$CWD'] }, block: { commands: [], paths: ['/workspace/project/private'] } } as unknown as typeof DEFAULT_RULES
    const { handlers, context, reviewer } = setup('accept', { rules })
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path: 'private/a' } }, context)).toMatchObject({ block: true })
    expect(reviewer).not.toHaveBeenCalled()
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'bash', input: { command: 'cat /workspace/project/a' } }, context)).toEqual({})
    expect(reviewer).toHaveBeenCalledOnce()
  })

  it('ACCEPT executes without confirmation', async () => {
    const { handlers, context } = setup('accept')
    expect(await handlers.get('tool_call')?.(call, context)).toEqual({}); expect(context.ui.confirm).not.toHaveBeenCalled()
  })
  it.each([{ name: 'ESCALATE', opts: {} }, { name: 'reviewer failure', opts: { throws: true } }, { name: 'config failure', opts: { valid: false } }])('$name uses local approval', async ({ opts }) => {
    const { handlers, context } = setup('escalate', { ...opts, approved: true })
    expect(await handlers.get('tool_call')?.(call, context)).toEqual({}); expect(context.ui.confirm).toHaveBeenCalledOnce()
  })
  it.each([{ name: 'ESCALATE', opts: {} }, { name: 'reviewer failure', opts: { throws: true } }])('$name enforces rejection', async ({ opts }) => {
    const { handlers, context } = setup('escalate', { ...opts, approved: false })
    expect(await handlers.get('tool_call')?.(call, context)).toMatchObject({ block: true });
  })
  it('fails closed without UI', async () => {
    const { handlers, context } = setup('escalate', { hasUI: false })
    expect(await handlers.get('tool_call')?.(call, context)).toMatchObject({ block: true }); expect(context.ui.confirm).not.toHaveBeenCalled()
  })
  it('keeps bash reviewed', async () => { const { handlers, context, reviewer } = setup('accept'); await handlers.get('tool_call')?.(call, context); expect(reviewer).toHaveBeenCalledOnce() })
  it('passes unreviewed tools through', async () => { const { handlers, context, reviewer } = setup('escalate'); expect(await handlers.get('tool_call')?.({ ...call, toolName: 'read' }, context)).toEqual({}); expect(reviewer).not.toHaveBeenCalled() })
})
