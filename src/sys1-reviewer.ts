import type { ClassifierAnswer, ClassifierResult } from '@earendil-works/pi-ai'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AutoReviewConfig } from './config.js'
import type { ReviewModelRegistry } from './model.js'
import type { ReviewAuthorizer, ReviewLog, ReviewPermissionDetails } from './review-types.js'
import type { ReviewAssessment } from './verdict.js'
import { availableReviewModels, configuredModel, resolveSys1Model, sameModel } from './model.js'
import { buildSys1State } from './prompt.js'
import { createReviewDeadline, raceWithSignal, reviewSleep, REVIEW_MAX_ATTEMPTS, REVIEW_RETRY_DELAYS_MS } from './review-deadline.js'
import { renderTranscript } from './transcript.js'

export const SYS1_PERMISSION_QUESTION_NAME = 'permission_decision'
const QUESTION = {
  type: 'choice' as const,
  instructions: 'Under the trusted policy and supplied evidence, choose the permission outcome for the exact bash action.',
  criteria: {
    ACCEPT: 'The action is safe to run without human approval under the policy.',
    ESCALATE: 'The action requires a human decision under the policy.',
  },
}

export interface Sys1ReviewerRuntime {
  config: AutoReviewConfig
  registry: ReviewModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
  sessionSignal?: AbortSignal
}

export interface Sys1ReviewerDependencies {
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function validPermissionAnswer(answer: ClassifierAnswer | undefined): boolean {
  if (answer?.type !== 'choice' || !['ACCEPT', 'ESCALATE'].includes(answer.choice)) return false
  const probabilities = answer.probabilities
  return probabilities !== undefined && probability(probabilities['ACCEPT']) && probability(probabilities['ESCALATE'])
}

// Confidence is not a portable probability (e.g. llama.cpp's normalized peak).
// Native malformed answers fail closed; valid ACCEPT ignores its confidence.
export function mapSys1PermissionDecision(answers: ClassifierResult['answers'], threshold: number): ReviewAssessment {
  const answer = answers[SYS1_PERMISSION_QUESTION_NAME]
  const valid = validPermissionAnswer(answer)
  const choice = valid && answer?.type === 'choice' ? answer.choice : 'INVALID'
  const pEscalate = valid && answer?.type === 'choice' ? answer.probabilities['ESCALATE'] : undefined
  return {
    outcome: choice === 'ACCEPT' || (choice === 'ESCALATE' && pEscalate !== undefined && pEscalate < threshold) ? 'ACCEPT' : 'ESCALATE',
    rationale: `sys1 permission_decision=${choice}; escalate_probability=${pEscalate ?? 'missing'}; sys1_escalate_threshold=${threshold}.`,
  }
}

export function createSys1Reviewer(runtime: Sys1ReviewerRuntime, dependencies: Sys1ReviewerDependencies = {}): ReviewAuthorizer {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? reviewSleep
  return async (details: ReviewPermissionDetails, log: ReviewLog) => {
    const startedAt = now()
    const deadline = createReviewDeadline(runtime.config.timeoutMs, runtime.sessionSignal)
    const { signal } = deadline
    let attempts = 0
    let phase = 'state-build'
    let category = 'internal-error'
    let lastError: unknown
    const common = () => ({
      requestId: details.requestId, toolCallId: details.toolCallId, toolName: details.toolName,
      provider: runtime.config.sys1_provider, model: runtime.config.sys1_model,
      policy: 'sys1', reviewer: 'sys1', attempts, durationMs: Math.max(0, now() - startedAt),
    })
    try {
      const state = { permissionReviewState: buildSys1State(runtime.config, renderTranscript(runtime.sessionManager.buildContextEntries()), details) }
      for (attempts = 1; attempts <= REVIEW_MAX_ATTEMPTS; attempts++) {
        try {
          if (signal.aborted) throw new Error('review cancelled')
          phase = 'model-resolution'
          const identity = configuredModel(runtime.config, 'sys1')
          const model = resolveSys1Model(runtime.registry, identity)
          if (model === undefined) { category = 'model-unresolved'; break }
          phase = 'model-availability'
          const available = await raceWithSignal(availableReviewModels(runtime.registry, 'sys1', signal, identity.provider), signal)
          if (!available.some(entry => sameModel(entry, identity))) { category = 'auth-unresolved'; break }
          if (signal.aborted || now() - startedAt >= runtime.config.timeoutMs) {
            category = deadline.timedOut() || !signal.aborted ? 'timeout' : 'cancelled'; break
          }
          phase = 'sys1-request'
          const response = await raceWithSignal(runtime.registry.classify(model, {
            state, questions: { [SYS1_PERMISSION_QUESTION_NAME]: QUESTION },
          }, { signal, timeoutMs: Math.max(1, runtime.config.timeoutMs - (now() - startedAt)), maxRetries: 0 }), signal)
          if (signal.aborted || now() - startedAt >= runtime.config.timeoutMs) {
            category = deadline.timedOut() || !signal.aborted ? 'timeout' : 'cancelled'; break
          }
          // Never permit apparently accepting partial answers after a failed call.
          if (response.stopReason !== 'stop') throw new Error(response.errorMessage ?? response.stopReason)
          phase = 'response-parse'
          if (!validPermissionAnswer(response.answers?.[SYS1_PERMISSION_QUESTION_NAME])) {
            category = 'invalid-response'
            lastError = new Error('native permission_decision requires a choice and valid ACCEPT/ESCALATE probabilities')
            if (attempts < REVIEW_MAX_ATTEMPTS) continue
            break
          }
          const assessment = mapSys1PermissionDecision(response.answers, runtime.config.sys1_escalate_threshold)
          log.review('auto_review.decision', { ...common(), outcome: assessment.outcome, rationale: assessment.rationale })
          return { kind: assessment.outcome === 'ACCEPT' ? 'accept' : 'escalate' }
        } catch (error) {
          lastError = error
          category = 'provider-error'
          if (signal.aborted) break
          if (attempts >= REVIEW_MAX_ATTEMPTS) break
          phase = 'retry-wait'
          await raceWithSignal(sleep(REVIEW_RETRY_DELAYS_MS[attempts - 1] ?? 0, signal), signal)
        }
      }
    } catch (error) { lastError = error }
    finally { deadline.dispose() }
    if (signal.aborted) category = deadline.timedOut() ? 'timeout' : 'cancelled'
    try {
      const failure = {
        ...common(), outcome: 'ESCALATE', errorCategory: category, failurePhase: phase,
        errorName: lastError instanceof Error ? lastError.name : undefined,
        errorMessage: lastError === undefined ? undefined : String(lastError).slice(0, 300),
      }
      log.review('auto_review.decision', failure)
      log.debug('auto_review.failure', failure)
    } catch { /* Logging never changes the permission boundary. */ }
    return { kind: 'escalate' }
  }
}
