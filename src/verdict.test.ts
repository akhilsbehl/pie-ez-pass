import { describe, expect, it } from 'vitest'
import { parseReviewAssessment } from './verdict.js'

describe('review assessment parser', () => {
  it('accepts exactly ACCEPT and ESCALATE', () => {
    expect(parseReviewAssessment('{"outcome":"ACCEPT","rationale":"Routine."}')).toEqual({ outcome: 'ACCEPT', rationale: 'Routine.' })
    expect(parseReviewAssessment('{"outcome":"ESCALATE","rationale":"Destructive."}')).toEqual({ outcome: 'ESCALATE', rationale: 'Destructive.' })
  })
  it('rejects legacy and incomplete verdicts', () => {
    expect(() => parseReviewAssessment('{"outcome":"allow","rationale":"Routine."}')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"redirect","redirect":"Narrow it.","rationale":"Broad."}')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"ACCEPT"}')).toThrow()
  })
})
