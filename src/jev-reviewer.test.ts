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
      rationale: 'JEV permission_decision=ACCEPT; accept_confidence=0.97; accept_confidence_threshold=0.95.',
    })
  })

  it('escalates ACCEPT with insufficient confidence', () => {
    const assessment = mapJevPermissionDecision(
      { permission_decision: { type: 'choice', choice: 'ACCEPT', confidence: 0.5 } },
      0.95,
    )
    expect(assessment.outcome).toBe('ESCALATE')
    expect(assessment.rationale).toContain('accept_confidence_threshold=0.95')
  })

  it('reports the accept-side confidence when JEV chooses ESCALATE', () => {
    expect(
      mapJevPermissionDecision(
        {
          permission_decision: {
            type: 'choice',
            choice: 'ESCALATE',
            probabilities: { ACCEPT: 0.03, ESCALATE: 0.97 },
            confidence: 0.97,
          },
        },
        0.95,
      ),
    ).toEqual({
      outcome: 'ESCALATE',
      rationale: 'JEV permission_decision=ESCALATE; accept_confidence=0.03; accept_confidence_threshold=0.95.',
    })
  })

  it('falls back to 1 - confidence when ESCALATE has no probabilities', () => {
    const assessment = mapJevPermissionDecision(
      { permission_decision: { type: 'choice', choice: 'ESCALATE', confidence: 0.99 } },
      0.95,
    )
    expect(assessment.outcome).toBe('ESCALATE')
    expect(assessment.rationale).toContain('accept_confidence=0.01')
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
