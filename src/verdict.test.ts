import { describe, expect, it } from 'vitest'
import { parseReviewAssessment } from './verdict.js'

describe('review assessment parser', () => {
  it('accepts exactly ACCEPT and ESCALATE', () => {
    expect(parseReviewAssessment('{"outcome":"ACCEPT","rationale":"Routine."}')).toEqual({ outcome: 'ACCEPT', rationale: 'Routine.' })
    expect(parseReviewAssessment('{"outcome":"ESCALATE","rationale":"Destructive."}')).toEqual({ outcome: 'ESCALATE', rationale: 'Destructive.' })
  })
  it('enforces the approximate 256-token UTF-8 bound without changing JSON extraction', () => {
    const payload = (rationale: string) => JSON.stringify({ outcome: 'ESCALATE', rationale })
    expect(parseReviewAssessment(`prose ${payload('x'.repeat(1024))} trailing`).rationale).toHaveLength(1024)
    expect(() => parseReviewAssessment(payload('x'.repeat(1025)))).toThrow('256-token')
    expect(parseReviewAssessment(payload('界'.repeat(341))).rationale).toHaveLength(341)
    expect(() => parseReviewAssessment(payload('界'.repeat(342)))).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"ACCEPT","rationale":"ok","extra":true}')).toThrow()
  })
  it('rejects legacy and incomplete verdicts', () => {
    expect(() => parseReviewAssessment('{"outcome":"allow","rationale":"Routine."}')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"redirect","redirect":"Narrow it.","rationale":"Broad."}')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"ACCEPT"}')).toThrow()
  })
})
