import type { AutoReviewConfig } from './config.js'
import type { ReviewModelRegistry } from './model.js'
import type { ReviewAssessment } from './verdict.js'
import type { AssistantMessage, Model, Api, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ReviewAuthorizer, ReviewLog, ReviewPermissionDetails } from './review-types.js'
import { configuredModel, resolveSys2Model, availableReviewModels, sameModel } from './model.js'
import { createReviewDeadline, raceWithSignal, reviewSleep, REVIEW_MAX_ATTEMPTS, REVIEW_RETRY_DELAYS_MS } from './review-deadline.js'
import { buildRetryUserPrompt, buildReviewPrompt } from './prompt.js'
import { renderTranscript } from './transcript.js'
import { NoJsonObjectError, parseReviewAssessment } from './verdict.js'

const MAX_OUTPUT_TOKENS = 256
const DECISION_EVENT = 'auto_review.decision'
const FAILURE_EVENT = 'auto_review.failure'

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'auth-unresolved'
  | 'provider-error'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'internal-error'

export interface ReviewerRuntime {
  config: AutoReviewConfig
  registry: ReviewModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
  sessionSignal?: AbortSignal
}

export interface ReviewerDependencies {
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  maxAttempts?: number
  retryDelaysMs?: number[]
}

interface Failure {
  message?: string
  name?: string
  phase?: string
  attempts?: number
  responsePreview?: string
  responseBlockTypes?: string
  stopReason?: string
  category: FailureCategory
}

interface ReviewCallResult {
  assessment: ReviewAssessment
  attempts: number
}

function responseText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

function buildStreamOptions(runtime: ReviewerRuntime, signal: AbortSignal, timeoutMs: number, reasoning: boolean): SimpleStreamOptions {
  return {
    maxRetries: 0, maxTokens: MAX_OUTPUT_TOKENS, signal, timeoutMs,
    ...(reasoning && runtime.config.sys2_reasoning !== 'off' ? { reasoning: runtime.config.sys2_reasoning } : {}),
  }
}

async function callProvider(
  registry: ReviewModelRegistry, model: Model<Api>, systemPrompt: string, userPrompt: string, options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return registry.streamSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
  }, options).result()
}

function writeFailure(
  log: ReviewLog,
  runtime: ReviewerRuntime,
  details: ReviewPermissionDetails,
  failure: Failure,
  durationMs: number,
): void {
  const common = {
    requestId: details.requestId,
    toolCallId: details.toolCallId,
    toolName: details.toolName,
    provider: runtime.config.sys2_provider,
    model: runtime.config.sys2_model,
    policy: 'sys2', reviewer: 'sys2',
    outcome: 'ESCALATE',
    errorCategory: failure.category,
    errorName: failure.name,
    errorMessage: failure.message,
    failurePhase: failure.phase,
    attempts: failure.attempts,
    responsePreview: failure.responsePreview,
    responseBlockTypes: failure.responseBlockTypes,
    stopReason: failure.stopReason,
    durationMs,
  }
  log.review(DECISION_EVENT, common)
  log.debug(FAILURE_EVENT, common)
}

function tryWriteFailure(
  log: ReviewLog,
  runtime: ReviewerRuntime,
  details: ReviewPermissionDetails,
  failure: Failure,
  durationMs: number,
): void {
  try {
    writeFailure(log, runtime, details, failure, durationMs)
  } catch {
    // Permission review failures must not escape into the fail-closed tool boundary.
  }
}

function elapsedMilliseconds(now: () => number, startedAt: number): number {
  try {
    return Math.max(0, now() - startedAt)
  } catch {
    return 0
  }
}

function describeParseProblem(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    const details = issues
      .slice(0, 3)
      .map(issue => {
        const { path, message } = issue as { path?: unknown[]; message?: string }
        const where = Array.isArray(path) && path.length > 0 ? path.join('.') : 'object'
        return `${where}: ${message ?? 'invalid'}`
      })
      .join('; ')
    return `it was JSON but did not match the required shape (${details}).`
  }
  if (error instanceof NoJsonObjectError) {
    return 'it did not contain a JSON object (it looked like prose or was empty).'
  }
  return 'it was not valid JSON (syntax error). Emit one well-formed object with double-quoted keys and strings.'
}

function annotatePermissionPrompt(
  details: ReviewPermissionDetails,
  assessment: ReviewAssessment,
): void {
  details.message = `${details.message}\n\n[Automatic review — advisory]\nRationale: ${assessment.rationale}`
}

async function runReview(
  runtime: ReviewerRuntime,
  details: ReviewPermissionDetails,
  dependencies: Required<Pick<ReviewerDependencies, 'now' | 'sleep' | 'maxAttempts' | 'retryDelaysMs'>>,
): Promise<ReviewCallResult | Failure> {
  const startedAt = dependencies.now()
  const deadline = createReviewDeadline(runtime.config.timeoutMs, runtime.sessionSignal)
  const { signal } = deadline

  try {
    const transcript = renderTranscript(runtime.sessionManager.buildContextEntries())
    const prompt = buildReviewPrompt(runtime.config, transcript, details)

    let userPrompt = prompt.userPrompt

    for (let attempt = 1; attempt <= dependencies.maxAttempts; attempt += 1) {
      try {
        if (signal.aborted) throw new Error('review cancelled')
        const identity = configuredModel(runtime.config, 'sys2')
        const model = resolveSys2Model(runtime.registry, identity)
        if (model === undefined) return { category: 'model-unresolved', phase: 'model-resolution', attempts: attempt }
        const available = await raceWithSignal(availableReviewModels(runtime.registry, 'sys2', signal, identity.provider), signal)
        if (!available.some(entry => sameModel(entry, identity))) {
          return { category: 'auth-unresolved', phase: 'model-availability', attempts: attempt }
        }
        if (signal.aborted || dependencies.now() - startedAt >= runtime.config.timeoutMs) {
          return { category: deadline.timedOut() || !signal.aborted ? 'timeout' : 'cancelled', attempts: attempt }
        }
        const remainingMs = Math.max(1, runtime.config.timeoutMs - (dependencies.now() - startedAt))
        const message = await raceWithSignal(
          callProvider(
            runtime.registry,
            model,
            prompt.systemPrompt,
            userPrompt,
            buildStreamOptions(runtime, signal, remainingMs, model.reasoning),
          ),
          signal,
        )

        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          const error = new Error(message.errorMessage ?? message.stopReason)
          error.name = `ProviderStop:${message.stopReason}`
          throw error
        }

        const text = responseText(message)
        try {
          const assessment = parseReviewAssessment(text)
          if (signal.aborted || dependencies.now() - startedAt >= runtime.config.timeoutMs) {
            return { category: deadline.timedOut() || !signal.aborted ? 'timeout' : 'cancelled', attempts: attempt }
          }
          return { assessment, attempts: attempt }
        } catch (error) {
          // Retry with targeted feedback: quote the rejected reply and say what the parser objected to.
          if (attempt < dependencies.maxAttempts) {
            userPrompt = buildRetryUserPrompt(prompt.userPrompt, text, describeParseProblem(error))
            continue
          }
          return {
            category: 'invalid-response',
            phase: 'response-parse',
            attempts: attempt,
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
            responsePreview: text.slice(0, 500),
            responseBlockTypes: message.content.map(block => block.type).join(','),
            stopReason: message.stopReason,
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return {
            category: deadline.timedOut() ? 'timeout' : 'cancelled',
          }
        }
        if (attempt >= dependencies.maxAttempts) {
          return {
            category: 'provider-error',
            phase: 'provider-request',
            attempts: attempt,
            name: error instanceof Error ? error.name : undefined,
            message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          }
        }
        const delay = dependencies.retryDelaysMs[attempt - 1] ?? dependencies.retryDelaysMs.at(-1) ?? 0
        try {
          await raceWithSignal(dependencies.sleep(delay, signal), signal)
        } catch {
          return {
            category: deadline.timedOut() ? 'timeout' : 'cancelled',
          }
        }
      }
    }
    return { category: 'provider-error', phase: 'provider-request', attempts: dependencies.maxAttempts }
  } finally {
    deadline.dispose()
  }
}

export function createSys2Reviewer(
  runtime: ReviewerRuntime,
  reviewerDependencies: ReviewerDependencies = {},
): ReviewAuthorizer {
  const dependencies = {
    now: reviewerDependencies.now ?? Date.now,
    sleep: reviewerDependencies.sleep ?? reviewSleep,
    maxAttempts: reviewerDependencies.maxAttempts ?? REVIEW_MAX_ATTEMPTS,
    retryDelaysMs: reviewerDependencies.retryDelaysMs ?? REVIEW_RETRY_DELAYS_MS,
  }

  return async (details, log) => {
    let startedAt = 0
    try {
      startedAt = dependencies.now()
      const result = await runReview(runtime, details, dependencies)
      const durationMs = elapsedMilliseconds(dependencies.now, startedAt)
      if ('category' in result) {
        writeFailure(log, runtime, details, result, durationMs)
        return { kind: 'escalate' }
      }

      const { assessment, attempts } = result
      log.review(DECISION_EVENT, {
        requestId: details.requestId,
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        provider: runtime.config.sys2_provider,
        model: runtime.config.sys2_model,
        policy: 'sys2', reviewer: 'sys2',
        outcome: assessment.outcome,
        rationale: assessment.rationale,
        attempts,
        durationMs,
      })

      if (assessment.outcome === 'ACCEPT') {
        return { kind: 'accept' }
      }

      // Surface escalation context in the native confirmation prompt.
      annotatePermissionPrompt(details, assessment)
      return { kind: 'escalate' }
    } catch {
      // Returning escalation remains the safe fallback even if local state is unavailable.
      tryWriteFailure(
        log,
        runtime,
        details,
        { category: 'internal-error' },
        elapsedMilliseconds(dependencies.now, startedAt),
      )
      return { kind: 'escalate' }
    }
  }
}
