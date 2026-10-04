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

// The reported confidence is always P(ESCALATE), regardless of which choice JEV
// selected, so the log reads as the escalate-side evidence against the
// escalate-side threshold. For an ACCEPT choice that is the complement:
// probabilities.ESCALATE when present, otherwise 1 - confidence.
function escalateConfidence(answer: Record<string, unknown> | undefined): number | undefined {
  if (answer === undefined || answer['type'] !== 'choice') {
    return undefined
  }
  const probabilities = answer['probabilities']
  if (isRecord(probabilities)) {
    const escalateProbability = probabilities['ESCALATE']
    if (typeof escalateProbability === 'number' && Number.isFinite(escalateProbability)) {
      return escalateProbability
    }
  }
  const confidence = answer['confidence']
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return undefined
  }
  if (answer['choice'] === 'ESCALATE') {
    return confidence
  }
  if (answer['choice'] === 'ACCEPT') {
    return Number((1 - confidence).toFixed(4))
  }
  return undefined
}

// ACCEPT is the default. JEV must itself choose ESCALATE with P(ESCALATE) at or
// above the threshold to escalate. A malformed answer still fails closed.
export function mapJevPermissionDecision(
  answers: Record<string, { type: string; [key: string]: unknown }>,
  threshold: number,
): ReviewAssessment {
  const raw = answers[JEV_PERMISSION_QUESTION_NAME]
  const answer = raw !== undefined && isRecord(raw) ? raw : undefined
  const choice = answer?.['choice']
  const confidence = escalateConfidence(answer)
  const confidenceText = confidence === undefined ? 'missing' : String(confidence)
  const decisionText = choice === 'ACCEPT' || choice === 'ESCALATE' ? String(choice) : 'INVALID'
  const rationale = `JEV permission_decision=${decisionText}; escalate_confidence=${confidenceText}; escalate_confidence_threshold=${threshold}.`

  if (answer !== undefined && choice === 'ACCEPT') {
    return { outcome: 'ACCEPT', rationale }
  }
  if (answer !== undefined && choice === 'ESCALATE' && confidence !== undefined && confidence < threshold) {
    return { outcome: 'ACCEPT', rationale }
  }
  return { outcome: 'ESCALATE', rationale }
}

export function createJevReviewer(runtime: JevReviewerRuntime): ReviewAuthorizer {
  return async (details: ReviewPermissionDetails, log: ReviewLog) => {
    const startedAt = Date.now()
    const transcript = renderTranscript(runtime.sessionManager.buildContextEntries())
    const state = buildJevState(runtime.config, transcript, details)
    const threshold = runtime.config.jev_escalate_confidence_threshold
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
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: message.slice(0, 300),
          failurePhase: 'jev-request',
          durationMs: duration(),
        })
        log.debug('auto_review.failure', {
          requestId: details.requestId,
          toolCallId: details.toolCallId,
          toolName: details.toolName,
          policy: 'jev-review',
          outcome: 'ESCALATE',
          errorCategory: category,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: message.slice(0, 300),
          failurePhase: 'jev-request',
          durationMs: duration(),
        })
      } catch {
        // Logging must never change the permission decision.
      }
      return { kind: 'escalate' }
    }
  }
}
