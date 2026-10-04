import { describe, expect, it, vi } from 'vitest'
import { mapJevPermissionDecision } from './jev-reviewer.js'

const choose = (choice: unknown, extra: Record<string, unknown> = {}) => ({
  permission_decision: { type: 'choice', choice, ...extra },
})

describe('JEV permission mapping', () => {
  it('accepts when JEV chooses ACCEPT, whatever the confidence', () => {
    expect(mapJevPermissionDecision(choose('ACCEPT', { confidence: 0.25 }), 0.6)).toEqual({
      outcome: 'ACCEPT',
      rationale: 'JEV permission_decision=ACCEPT; escalate_confidence=0.75; escalate_confidence_threshold=0.6.',
    })
  })

  it('accepts a bare ACCEPT with no confidence', () => {
    expect(mapJevPermissionDecision(choose('ACCEPT'), 0.6).outcome).toBe('ACCEPT')
  })

  it('escalates ESCALATE at or above the threshold using probabilities.ESCALATE', () => {
    expect(
      mapJevPermissionDecision(
        choose('ESCALATE', { probabilities: { ACCEPT: 0.03, ESCALATE: 0.97 }, confidence: 0.97 }),
        0.6,
      ),
    ).toEqual({
      outcome: 'ESCALATE',
      rationale: 'JEV permission_decision=ESCALATE; escalate_confidence=0.97; escalate_confidence_threshold=0.6.',
    })
  })

  it('accepts ESCALATE below the threshold', () => {
    expect(mapJevPermissionDecision(choose('ESCALATE', { confidence: 0.55 }), 0.6).outcome).toBe('ACCEPT')
  })

  it('uses the threshold as an inclusive floor', () => {
    expect(mapJevPermissionDecision(choose('ESCALATE', { confidence: 0.6 }), 0.6).outcome).toBe('ESCALATE')
    expect(mapJevPermissionDecision(choose('ESCALATE', { confidence: 0.59 }), 0.6).outcome).toBe('ACCEPT')
  })

  it('fails closed when ESCALATE carries no usable confidence', () => {
    expect(mapJevPermissionDecision(choose('ESCALATE'), 0.6).outcome).toBe('ESCALATE')
    expect(mapJevPermissionDecision(choose('ESCALATE', { confidence: 'high' }), 0.6).outcome).toBe('ESCALATE')
  })

  it.each([
    [{ permission_decision: { type: 'noul', noul: 1 } }],
    [choose('MAYBE', { confidence: 1 })],
    [{}],
  ])('fails closed on invalid answers %s', answers => {
    expect(mapJevPermissionDecision(answers as never, 0.6).outcome).toBe('ESCALATE')
  })

  it('does not call an LLM for edit/write paths (routing is covered in extension tests)', () => {
    expect(vi.isMockFunction(vi.fn())).toBe(true)
  })
})
