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

export function mapJevPermissionDecision(
  answers: Record<string, { type: string; [key: string]: unknown }>,
  threshold: number,
): ReviewAssessment {
  const answer = answers[JEV_PERMISSION_QUESTION_NAME]
  const confidence = answer !== undefined && isRecord(answer) ? answer['confidence'] : undefined
  const choice = answer !== undefined && isRecord(answer) ? answer['choice'] : undefined
  const confidenceText = typeof confidence === 'number' && Number.isFinite(confidence) ? String(confidence) : 'missing'

  if (
    answer !== undefined &&
    answer.type === 'choice' &&
    choice === 'ACCEPT' &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= threshold
  ) {
    return {
      outcome: 'ACCEPT',
      rationale: `JEV permission_decision=ACCEPT; confidence=${confidence}; threshold=${threshold}.`,
    }
  }

  const decisionText =
    answer !== undefined && answer.type === 'choice' && (choice === 'ACCEPT' || choice === 'ESCALATE')
      ? String(choice)
      : 'INVALID'
  return {
    outcome: 'ESCALATE',
    rationale: `JEV permission_decision=${decisionText}; confidence=${confidenceText}; threshold=${threshold}.`,
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
