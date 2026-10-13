import { describe, expect, it } from 'vitest'
import { mapSys1PermissionDecision } from './sys1-reviewer.js'
import { nativeAnswer } from './reviewer-test-fixtures.js'

describe('native sys1 probability mapping', () => {
  it('accepts valid ACCEPT regardless of confidence or escalation probability', () => {
    const assessment = mapSys1PermissionDecision(nativeAnswer('ACCEPT', 0.75, 0.01).answers, 0.6)
    expect(assessment).toEqual({ outcome: 'ACCEPT', rationale: 'sys1 permission_decision=ACCEPT; escalate_probability=0.75; sys1_escalate_threshold=0.6.' })
  })
  it.each([[0.59, 'ACCEPT'], [0.6, 'ESCALATE'], [0.97, 'ESCALATE']] as const)('uses inclusive P(ESCALATE) threshold %s', (p, outcome) => {
    expect(mapSys1PermissionDecision(nativeAnswer('ESCALATE', p, 0.01).answers, 0.6).outcome).toBe(outcome)
  })
  it('never substitutes confidence or its complement for probability', () => {
    const answers = nativeAnswer('ESCALATE', 0.4, 0.99).answers
    expect(mapSys1PermissionDecision(answers, 0.6).outcome).toBe('ACCEPT')
    delete (answers.permission_decision as any).probabilities
    expect(mapSys1PermissionDecision(answers, 0.6).outcome).toBe('ESCALATE')
  })
  it.each([
    {}, { permission_decision: { type: 'bool', probability: 1 } },
    { permission_decision: { type: 'choice', choice: 'ACCEPT' } },
    nativeAnswer('UNKNOWN').answers,
    ...[-0.1, 1.1, NaN, Infinity, 'high'].map(p => ({ permission_decision: { type: 'choice', choice: 'ACCEPT', probabilities: { ACCEPT: 0.5, ESCALATE: p } } })),
    { permission_decision: { type: 'choice', choice: 'ACCEPT', probabilities: { ESCALATE: 0.2 } } },
  ])('rejects malformed native answer %j', answers => {
    expect(mapSys1PermissionDecision(answers as never, 0.6).outcome).toBe('ESCALATE')
  })
})
