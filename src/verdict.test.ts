import { describe, expect, it } from 'vitest'
import { parseReviewAssessment } from './verdict.js'

describe('review assessment parser', () => {
  it('accepts allow', () => {
    expect(parseReviewAssessment('{"outcome":"allow"}')).toMatchObject({ outcome: 'allow', riskLevel: 'low' })
  })

  it('requires and preserves a redirect instruction', () => {
    expect(
      parseReviewAssessment(
        '{"outcome":"redirect","risk_level":"medium","redirect":"Limit the edit to one file.","rationale":"The scope is broad."}',
      ),
    ).toMatchObject({
      outcome: 'redirect',
      riskLevel: 'medium',
      redirect: 'Limit the edit to one file.',
    })
    expect(() => parseReviewAssessment('{"outcome":"redirect"}')).toThrow()
  })

  it('accepts escalation', () => {
    expect(parseReviewAssessment('{"outcome":"escalate","rationale":"This needs user confirmation."}')).toMatchObject({
      outcome: 'escalate',
      rationale: 'This needs user confirmation.',
    })
  })
})
