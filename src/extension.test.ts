import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewLog } from './review-types.js'
import { DEFAULT_RULES } from './config.js'
import { createAutoReviewExtension } from './extension.js'

const TEST_RULES = {
  allow: { commands: ['pwd', 'git status', 'git diff', 'git diff *', 'git log', 'git log *', 'git show', 'git show *', 'git rev-parse *', 'git ls-files', 'git ls-files *', 'npm test', 'npm test *', 'npm run typecheck', 'npm run build', 'npm run lint'], paths: ['$CWD', '/tmp', '~/tmp', '~/.richie', '~/.pi', '~/warchives'] },
  block: { commands: ['sudo', 'sudo *', 'rm -rf /', 'rm -rf /*', 'git push --force', 'git push --force *', 'git push -f', 'git push -f *', 'git reset --hard', 'git reset --hard *', 'git clean -f', 'git clean -f *'], paths: [] },
} as typeof DEFAULT_RULES

function setup(kind: 'accept' | 'escalate', options: { valid?: boolean; throws?: boolean; hasUI?: boolean; approved?: boolean; rules?: typeof DEFAULT_RULES; cwd?: string } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const pi = { on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)), registerCommand: vi.fn() }
  const reviewer = vi.fn(async () => { if (options.throws) throw new Error('provider failed'); return { kind } })
  const reviewLog: ReviewLog = { review: vi.fn(), debug: vi.fn() }
  createAutoReviewExtension(pi as never, {
    loadConfig: () => ({ config: options.valid === false ? undefined : { provider: 'test', model: 'review', reasoning: 'off', timeoutMs: 1000, rules: options.rules ?? TEST_RULES }, issues: [], globalPath: '', projectPath: '' }),
    createReviewer: () => reviewer, reviewLog,
  })
  const context = { cwd: options.cwd ?? '/workspace/project', modelRegistry: {}, sessionManager: { buildContextEntries: () => [] }, hasUI: options.hasUI ?? true, ui: { confirm: vi.fn(async () => options.approved ?? true) } }
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
    const conflict = setup('accept', { rules, approved: false }); expect(await conflict.handlers.get('tool_call')?.({ ...call, input: { command: 'git show secret-file' } }, conflict.context)).toMatchObject({ block: true }); expect(conflict.context.ui.confirm).not.toHaveBeenCalled()
    const anchored = setup('escalate', { rules, approved: false }); expect(await anchored.handlers.get('tool_call')?.({ ...call, input: { command: 'echo git show HEAD' } }, anchored.context)).toMatchObject({ block: true }); expect(anchored.reviewer).toHaveBeenCalledOnce()
  })

  it('chooses the most-specific command rule symmetrically regardless of order', async () => {
    const exactAllow = { allow: { commands: ['sudo systemctl restart richie.service'], paths: [] }, block: { commands: ['sudo *'], paths: [] } } as typeof DEFAULT_RULES
    const allowed = setup('escalate', { rules: exactAllow })
    expect(await allowed.handlers.get('tool_call')?.({ ...call, input: { command: 'sudo systemctl restart richie.service' } }, allowed.context)).toEqual({})
    expect(allowed.reviewer).not.toHaveBeenCalled()
    const exactBlock = { allow: { commands: ['sudo *'], paths: [] }, block: { commands: ['sudo foo'], paths: [] } } as typeof DEFAULT_RULES
    const blocked = setup('accept', { rules: exactBlock })
    expect(await blocked.handlers.get('tool_call')?.({ ...call, input: { command: 'sudo foo' } }, blocked.context)).toMatchObject({ block: true })
    expect(blocked.reviewer).not.toHaveBeenCalled()
  })

  it('uses explicit-human conflict handling when best command rules remain equally specific', async () => {
    const rules = { allow: { commands: ['sudo *x'], paths: [] }, block: { commands: ['sudo x*'], paths: [] } } as typeof DEFAULT_RULES
    const tied = setup('accept', { rules, approved: false })
    expect(await tied.handlers.get('tool_call')?.({ ...call, input: { command: 'sudo xx' } }, tied.context)).toMatchObject({ block: true })
    expect(tied.reviewer).not.toHaveBeenCalled()
    expect(tied.context.ui.confirm).toHaveBeenCalledOnce()
  })

  it.each(['echo a; echo b', 'echo a &', 'echo a | cat', 'echo a\necho b', 'echo a\recho b', 'echo `date`', 'echo $(date)', 'cat <(echo x)', 'tee >(cat)', "echo ';'", String.raw`echo \|`, 'echo x 2>&1'])('defers compound-looking command %j to the reviewer', async command => {
    const rules = { allow: { commands: ['*'], paths: [] }, block: { commands: [], paths: [] } } as typeof DEFAULT_RULES
    const reviewed = setup('accept', { rules })
    expect(await reviewed.handlers.get('tool_call')?.({ ...call, input: { command } }, reviewed.context)).toEqual({})
    expect(reviewed.reviewer).toHaveBeenCalledOnce()
  })

  it('uses only explicit paths and lets a narrower block win', async () => {
    const rules = { allow: { commands: [], paths: ['$CWD'] }, block: { commands: [], paths: ['/workspace/project/private'] } } as unknown as typeof DEFAULT_RULES
    const { handlers, context, reviewer } = setup('accept', { rules })
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path: 'private/a' } }, context)).toMatchObject({ block: true })
    expect(reviewer).not.toHaveBeenCalled()
    expect(await handlers.get('tool_call')?.({ ...call, toolName: 'bash', input: { command: 'cat /workspace/project/a' } }, context)).toEqual({})
    expect(reviewer).toHaveBeenCalledOnce()
  })

  it('chooses a narrower path rule on either side', async () => {
    const narrowAllow = setup('escalate', { rules: { allow: { commands: [], paths: ['/workspace/project/safe'] }, block: { commands: [], paths: ['/workspace/project'] } } as typeof DEFAULT_RULES })
    expect(await narrowAllow.handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path: '/workspace/project/safe/a' } }, narrowAllow.context)).toEqual({})
    const narrowBlock = setup('accept', { rules: { allow: { commands: [], paths: ['/workspace/project'] }, block: { commands: [], paths: ['/workspace/project/private'] } } as typeof DEFAULT_RULES })
    expect(await narrowBlock.handlers.get('tool_call')?.({ ...call, toolName: 'edit', input: { path: '/workspace/project/private/a' } }, narrowBlock.context)).toMatchObject({ block: true })
  })

  it.each(['allow', 'block'] as const)('matches %s path rules through lexical and resolved symlink directions, including missing children', async side => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-paths-'))
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    mkdirSync(real)
    symlinkSync(real, alias)
    const expected = side === 'allow' ? {} : { block: true }
    for (const [rule, target] of [[alias, join(real, 'missing', 'a')], [real, join(alias, 'missing', 'a')]]) {
      const rules = { allow: { commands: [], paths: side === 'allow' ? [rule] : [] }, block: { commands: [], paths: side === 'block' ? [rule] : [] } } as unknown as typeof DEFAULT_RULES
      const run = setup(side === 'allow' ? 'escalate' : 'accept', { rules, cwd: root })
      expect(await run.handlers.get('tool_call')?.({ ...call, toolName: 'write', input: { path: target } }, run.context)).toMatchObject(expected)
      expect(run.reviewer).not.toHaveBeenCalled()
    }
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
