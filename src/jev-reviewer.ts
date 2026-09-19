import { askJev } from 'pie-jev'
import type { AutoReviewConfig } from './config.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ReviewAuthorizer, ReviewLog, ReviewPermissionDetails } from './review-types.js'
import type { ReviewAssessment } from './verdict.js'
import { buildJevState } from './prompt.js'
import { renderTranscript } from './transcript.js'

export const JEV_PERMISSION_QUESTION_NAME = 'permission_decision'

const JEV_QUESTION_INSTRUCTIONS =
  'Under the trusted policy and supplied evidence, choose the permission outcome for the exact bash action.'

const JEV_QUESTION_CRITERIA = {
  ACCEPT: 'The action is safe to run without human approval under the policy.',
  ESCALATE: 'The action requires a human decision under the policy.',
} as const

export interface JevReviewerRuntime {
  config: AutoReviewConfig
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
  sessionSignal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The reported confidence is always P(ACCEPT), regardless of which choice JEV
// selected, so the log reads as the accept-side evidence against the accept-side
// threshold. For an ESCALATE choice that is the complement: probabilities.ACCEPT
// when present, otherwise 1 - confidence.
function acceptConfidence(answer: Record<string, unknown> | undefined): number | undefined {
  if (answer === undefined || answer['type'] !== 'choice') {
    return undefined
  }
  if (answer['choice'] === 'ACCEPT') {
    const confidence = answer['confidence']
    return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : undefined
  }
  if (answer['choice'] === 'ESCALATE') {
    const probabilities = answer['probabilities']
    if (isRecord(probabilities)) {
      const acceptProbability = probabilities['ACCEPT']
      if (typeof acceptProbability === 'number' && Number.isFinite(acceptProbability)) {
        return acceptProbability
      }
    }
    const confidence = answer['confidence']
    if (typeof confidence === 'number' && Number.isFinite(confidence)) {
      return Number((1 - confidence).toFixed(4))
    }
  }
  return undefined
}

export function mapJevPermissionDecision(
  answers: Record<string, { type: string; [key: string]: unknown }>,
  threshold: number,
): ReviewAssessment {
  const raw = answers[JEV_PERMISSION_QUESTION_NAME]
  const answer = raw !== undefined && isRecord(raw) ? raw : undefined
  const choice = answer?.['choice']
  const confidence = acceptConfidence(answer)
  const confidenceText = confidence === undefined ? 'missing' : String(confidence)

  if (answer !== undefined && choice === 'ACCEPT' && confidence !== undefined && confidence >= threshold) {
    return {
      outcome: 'ACCEPT',
      rationale: `JEV permission_decision=ACCEPT; accept_confidence=${confidence}; accept_confidence_threshold=${threshold}.`,
    }
  }

  const decisionText = choice === 'ACCEPT' || choice === 'ESCALATE' ? String(choice) : 'INVALID'
  return {
    outcome: 'ESCALATE',
    rationale: `JEV permission_decision=${decisionText}; accept_confidence=${confidenceText}; accept_confidence_threshold=${threshold}.`,
  }
}

export function createJevReviewer(runtime: JevReviewerRuntime): ReviewAuthorizer {
  return async (details: ReviewPermissionDetails, log: ReviewLog) => {
    const startedAt = Date.now()
    const transcript = renderTranscript(runtime.sessionManager.buildContextEntries())
    const state = buildJevState(runtime.config, transcript, details)
    const threshold = runtime.config.jev_accept_confidence_threshold
    const duration = (): number => Math.max(0, Date.now() - startedAt)

    try {
      const response = await askJev(
        state,
        {
          [JEV_PERMISSION_QUESTION_NAME]: {
            type: 'choice',
            instructions: JEV_QUESTION_INSTRUCTIONS,
            criteria: JEV_QUESTION_CRITERIA,
          },
        },
        {
          signal: runtime.sessionSignal,
          timeoutMs: runtime.config.timeoutMs,
        },
      )
      const assessment = mapJevPermissionDecision(
        response.answers as Record<string, { type: string; [key: string]: unknown }>,
        threshold,
      )
      log.review('auto_review.decision', {
        requestId: details.requestId,
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        policy: 'jev-review',
        outcome: assessment.outcome,
        rationale: assessment.rationale,
        durationMs: duration(),
      })
      if (assessment.outcome === 'ACCEPT') {
        return { kind: 'accept' }
      }
      return { kind: 'escalate' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const category =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : error instanceof Error && error.name === 'AbortError'
            ? 'cancelled'
            : 'provider-error'
      try {
        log.review('auto_review.decision', {
          requestId: details.requestId,
          toolCallId: details.toolCallId,
          toolName: details.toolName,
          policy: 'jev-review',
          outcome: 'ESCALATE',
          errorCategory: category,
          durationMs: duration(),
        })
        log.debug('auto_review.failure', {
          requestId: details.requestId,
          toolCallId: details.toolCallId,
          toolName: details.toolName,
          policy: 'jev-review',
          outcome: 'ESCALATE',
          errorCategory: category,
          durationMs: duration(),
        })
      } catch {
        // Logging must never change the permission decision.
      }
      void message
      return { kind: 'escalate' }
    }
  }
}
