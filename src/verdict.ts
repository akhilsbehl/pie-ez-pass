import { z } from 'zod'

const assessmentPayloadSchema = z.strictObject({
  outcome: z.enum(['ACCEPT', 'ESCALATE']),
  rationale: z.string().trim().min(1).max(4_000),
})

/** Thrown when the reply contains no JSON object at all (e.g. a prose answer). */
export class NoJsonObjectError extends Error {
  constructor() {
    super('review response was not valid JSON')
    this.name = 'NoJsonObjectError'
  }
}

export interface ReviewAssessment {
  outcome: 'ACCEPT' | 'ESCALATE'
  rationale: string
}

function parseJsonObject(text: string): unknown {
  try { return JSON.parse(text) } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new NoJsonObjectError()
    return JSON.parse(text.slice(start, end + 1))
  }
}

export function parseReviewAssessment(text: string): ReviewAssessment {
  return assessmentPayloadSchema.parse(parseJsonObject(text))
}
