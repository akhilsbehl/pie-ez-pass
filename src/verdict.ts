import { z } from 'zod'

const assessmentPayloadSchema = z.strictObject({
  outcome: z.enum(['ACCEPT', 'ESCALATE']),
  rationale: z.string().trim().min(1).max(4_000),
})

export interface ReviewAssessment {
  outcome: 'ACCEPT' | 'ESCALATE'
  rationale: string
}

function parseJsonObject(text: string): unknown {
  try { return JSON.parse(text) } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('review response was not valid JSON')
    return JSON.parse(text.slice(start, end + 1))
  }
}

export function parseReviewAssessment(text: string): ReviewAssessment {
  return assessmentPayloadSchema.parse(parseJsonObject(text))
}
