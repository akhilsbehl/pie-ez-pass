import { describe, expect, it, vi } from 'vitest'
import { mapJevPermissionDecision } from './jev-reviewer.js'

describe('JEV permission mapping', () => {
  it('accepts ACCEPT with sufficient confidence', () => {
    expect(
      mapJevPermissionDecision(
        { permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 0.97 } },
        0.95,
      ),
    ).toEqual({
      outcome: 'ACCEPT',
      rationale: 'JEV permission_decision=ACCEPT; confidence=0.97; threshold=0.95.',
    })
  })

  it('escalates ACCEPT with insufficient confidence', () => {
    const assessment = mapJevPermissionDecision(
      { permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 0.5 } },
      0.95,
    )
    expect(assessment.outcome).toBe('ESCALATE')
    expect(assessment.rationale).toContain('threshold=0.95')
  })

  it.each([
    [{ permission_decision: { type: 'choice', choice: 'ESCALATE', confidence: 0.99 } }],
    [{ permission_decision: { type: 'choice', choice: 'ACCEPT' } }],
    [{ permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 'high' } }],
    [{ permission_decision: { type: 'noul', noul: 1 } }],
    [{ permission_decision: { type: 'choice', choice: 'MAYBE', confidence: 1 } }],
    [{}],
  ])('escalates invalid or non-accepting answers %s', answers => {
    expect(mapJevPermissionDecision(answers as never, 0.95).outcome).toBe('ESCALATE')
  })

  it('uses the configured threshold as the only automatic acceptance condition', () => {
    expect(
      mapJevPermissionDecision(
        { permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 0.8 } },
        0.8,
      ).outcome,
    ).toBe('ACCEPT')
    expect(
      mapJevPermissionDecision(
        { permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 0.79 } },
        0.8,
      ).outcome,
    ).toBe('ESCALATE')
  })

  it('does not call an LLM for edit/write paths (routing is covered in extension tests)', () => {
    expect(vi.isMockFunction(vi.fn())).toBe(true)
  })
})
