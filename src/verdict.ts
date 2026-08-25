import { z } from 'zod'

const assessmentPayloadSchema = z
  .strictObject({
    risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    user_authorization: z.enum(['unknown', 'low', 'medium', 'high']).optional(),
    outcome: z.enum(['allow', 'redirect', 'escalate']),
    rationale: z.string().trim().min(1).max(4_000).optional(),
    redirect: z.string().trim().min(1).max(4_000).optional(),
  })
  .superRefine((payload, context) => {
    if (payload.outcome === 'redirect' && payload.redirect === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'redirect is required when outcome is redirect',
        path: ['redirect'],
      })
    }
  })

type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
type UserAuthorization = 'unknown' | 'low' | 'medium' | 'high'

export interface ReviewAssessment {
  riskLevel: RiskLevel
  userAuthorization: UserAuthorization
  outcome: 'allow' | 'redirect' | 'escalate'
  rationale: string
  redirect?: string
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) {
      throw new Error('review response was not valid JSON')
    }
    return JSON.parse(text.slice(start, end + 1))
  }
}

export function parseReviewAssessment(text: string): ReviewAssessment {
  const payload = assessmentPayloadSchema.parse(parseJsonObject(text))
  const riskLevel = payload.risk_level ?? (payload.outcome === 'allow' ? 'low' : 'high')
  const rationale =
    payload.rationale ??
    (payload.outcome === 'allow'
      ? 'Automatic review returned a low-risk allow decision.'
      : payload.outcome === 'redirect'
        ? 'The requested action should be narrowed before it is attempted.'
        : 'Automatic review requires direct user confirmation.')

  return {
    riskLevel,
    userAuthorization: payload.user_authorization ?? 'unknown',
    outcome: payload.outcome,
    rationale,
    ...(payload.redirect === undefined ? {} : { redirect: payload.redirect }),
  }
}
