import { z } from 'zod'

// No public model-independent tokenizer is available. Use ~4 UTF-8 bytes/token,
// matching the requested 256-token budget conservatively for non-ASCII text.
export const MAX_RATIONALE_TOKENS = 256
export const MAX_RATIONALE_BYTES = MAX_RATIONALE_TOKENS * 4

const assessmentPayloadSchema = z.strictObject({
  outcome: z.enum(['ACCEPT', 'ESCALATE']),
  rationale: z.string().trim().min(1).refine(
    value => Buffer.byteLength(value, 'utf8') <= MAX_RATIONALE_BYTES,
    'rationale must fit the approximate 256-token limit (1024 UTF-8 bytes)',
  ),
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
