import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './policy.js'

describe('personal default review policy', () => {
  it('uses concise reviewer semantics without implementation details', () => {
    const prompt = buildSystemPrompt({
      provider: 'openai-codex',
      model: 'codex-auto-review',
      reasoning: 'low',
      timeoutMs: 90_000,
    })

    expect(prompt).toContain('\"outcome\": \"ACCEPT\" | \"ESCALATE\"')
    expect(prompt).toContain('Strongly default to ACCEPT')
    expect(prompt).not.toContain('~/.richie')
    expect(prompt).not.toContain('permission-system authorizer')
    expect(prompt).not.toContain('{"kind":"defer"}')
    expect(prompt).toContain("extension's local\nconfirmation UI")
    expect(prompt).toContain('source is exactly "user"')
    expect(prompt).toContain('weighs strongly toward ACCEPT')
    expect(prompt).toContain('does not erase an unmistakable severe footgun')
    expect(prompt).not.toContain('medim')
  })

  it('retains optional additional policy support', () => {
    const prompt = buildSystemPrompt({
      provider: 'openai-codex',
      model: 'codex-auto-review',
      reasoning: 'low',
      timeoutMs: 90_000,
      additionalPolicy: 'Prefer explicit confirmation for this test action.',
    })

    expect(prompt).toContain('Prefer explicit confirmation for this test action.')
  })
})
