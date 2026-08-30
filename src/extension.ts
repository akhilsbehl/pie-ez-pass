import { randomUUID } from 'node:crypto'
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  SessionManager,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import type { AutoReviewActivationResult } from './command.js'
import type { AutoReviewConfig, LoadConfigResult } from './config.js'
import { registerAutoReviewCommand } from './command.js'
import { AutoReviewConfigStore } from './config-store.js'
import { createPermissionReviewer } from './reviewer.js'
import type { ReviewAuthorizer, ReviewLog, ReviewPermissionDetails } from './review-types.js'
import { decidePermanentRule } from './permission-rules.js'
import { createPermissionLog } from './permission-log.js'

interface ReviewerFactoryOptions {
  config: AutoReviewConfig
  registry: ModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
  sessionSignal: AbortSignal
}

export interface AutoReviewExtensionDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult
  createReviewer?: (options: ReviewerFactoryOptions) => ReviewAuthorizer
  reviewLog?: ReviewLog
}

interface ReviewerGeneration {
  config: AutoReviewConfig | undefined
  controller: AbortController
  authorize: ReviewAuthorizer
}

interface SessionRuntime {
  cwd: string
  registry: ModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
}

const REVIEWED_TOOLS = new Set(['bash', 'edit', 'write'])
export const PERMISSION_CONFIRMATION_EVENT = 'pie-ez-pass:permission-confirmation:v1'

function ignoreDiagnostic(_message: string): void {
  // The extension is silent during normal operation. Escalation is the user-visible boundary.
}

function emitPermissionConfirmation(pi: Pick<ExtensionAPI, 'events'>, requestId: string, active: boolean): void {
  try {
    pi.events.emit(PERMISSION_CONFIRMATION_EVENT, { requestId, active })
  } catch {
    // Event observers must not affect permission decisions or lifecycle cleanup.
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function serializeInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return '[input could not be serialized]'
  }
}

function buildPermissionDetails(event: ToolCallEvent): ReviewPermissionDetails {
  const input = asRecord(event.input)
  const path = asString(input['path'])
  const command = asString(input['command'])
  const target = asString(input['target'])
  const toolInputPreview = serializeInput(input)
  const value = path ?? command ?? target ?? event.toolName

  return {
    requestId: event.toolCallId,
    source: 'tool_call',
    message: `Permission requested for ${event.toolName}.\n\nInput: ${toolInputPreview}`,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    path,
    command,
    target,
    toolInputPreview,
    surface: event.toolName,
    value,
  }
}

function invalidConfigReviewer(): ReviewAuthorizer {
  return async (details, log) => {
    log.review('auto_review.decision', {
      requestId: details.requestId,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      policy: 'configuration',
      outcome: 'ESCALATE',
      errorCategory: 'config-invalid',
    })
    return { kind: 'escalate' }
  }
}

function installAutoReviewExtension(
  pi: ExtensionAPI,
  configStore: AutoReviewConfigStore,
  dependencies: AutoReviewExtensionDependencies,
): void {
  const loadConfig = dependencies.loadConfig ?? ((cwd: string) => configStore.load(cwd))
  const createReviewer =
    dependencies.createReviewer ??
    ((options: ReviewerFactoryOptions) =>
      createPermissionReviewer({
        ...options,
      }))
  const configuredReviewLog = dependencies.reviewLog ?? createPermissionLog()
  let sessionId = randomUUID()
  const reviewLog: ReviewLog = {
    review: (event, details) => {
      try {
        configuredReviewLog.review(event, { ...details, sessionId })
      } catch {
        // Logging must never change the permission decision.
      }
    },
    debug: (event, details) => {
      try {
        configuredReviewLog.debug(event, { ...details, sessionId })
      } catch {
        // Logging must never change the permission decision.
      }
    },
  }

  let sessionRuntime: SessionRuntime | undefined
  let generation: ReviewerGeneration | undefined

  function createGeneration(config: AutoReviewConfig | undefined): ReviewerGeneration | undefined {
    if (sessionRuntime === undefined) {
      return undefined
    }

    const controller = new AbortController()
    try {
      return {
        config,
        controller,
        authorize:
          config === undefined
            ? invalidConfigReviewer()
            : createReviewer({
                config,
                registry: sessionRuntime.registry,
                sessionManager: sessionRuntime.sessionManager,
                sessionSignal: controller.signal,
              }),
      }
    } catch (error) {
      controller.abort()
      throw error
    }
  }

  function reportIssues(result: LoadConfigResult): void {
    for (const issue of result.issues) {
      ignoreDiagnostic(`config issue at ${issue.sourcePath}: ${issue.message}`)
    }
  }

  async function handleToolCall(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult> {
    if (!REVIEWED_TOOLS.has(event.toolName)) {
      return {}
    }

    const details = buildPermissionDetails(event)
    reviewLog.review('permission.tool_call', {
      requestId: details.requestId,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      operation: event.toolName,
      requestSummary:
        details.command !== undefined
          ? details.command
          : details.path !== undefined
            ? `${event.toolName} path=${details.path}`
            : details.target !== undefined
              ? `${event.toolName} target=${details.target}`
              : event.toolName,
      toolInputPreview: details.toolInputPreview,
      inputKeys: Object.keys(asRecord(event.input)),
      value: details.value,
    })
    const current = generation
    const ruleDecision = current?.config !== undefined && sessionRuntime !== undefined
      ? decidePermanentRule(event.toolName, event.toolName === 'bash' ? details.command : details.path, current.config, sessionRuntime.cwd)
      : 'none'
    if (ruleDecision === 'allow') {
      reviewLog.review('permission.decision', { requestId: details.requestId, toolName: details.toolName, policy: 'permanent-rule', outcome: 'ACCEPT' })
      return {}
    }
    if (ruleDecision === 'block') {
      reviewLog.review('permission.decision', { requestId: details.requestId, toolName: details.toolName, policy: 'permanent-rule', outcome: 'BLOCK' })
      return { block: true, reason: 'Blocked by a permanent permission rule.' }
    }

    let verdict: Awaited<ReturnType<ReviewAuthorizer>> = { kind: 'escalate' }
    let failureReason: string | undefined
    if (current === undefined || current.config === undefined) {
      failureReason = 'Automatic permission review is unavailable because its configuration is invalid.'
      reviewLog.review('permission.escalated', {
        requestId: details.requestId, toolName: details.toolName, outcome: 'ESCALATE', reasonCode: 'config-invalid',
      })
    } else if (ruleDecision !== 'conflict') {
      try {
        verdict = await current.authorize(details, reviewLog)
      } catch (error) {
        failureReason = 'Automatic permission review failed; human approval is required.'
        ignoreDiagnostic(`review failed: ${error instanceof Error ? error.message : String(error)}`)
        reviewLog.review('permission.error', { requestId: details.requestId, toolName: details.toolName, errorCategory: 'authorizer-error' })
      }
    } else {
      failureReason = 'This call has equally specific allow and block rules; explicit human confirmation is required.'
    }

    if (verdict.kind === 'accept') return {}
    reviewLog.review('permission.escalated', {
      requestId: details.requestId, toolName: details.toolName, outcome: 'ESCALATE',
    })
    if (!context.hasUI) {
      return { block: true, reason: failureReason ?? 'Human confirmation is required, but no interactive UI is available.' }
    }
    try {
      emitPermissionConfirmation(pi, details.requestId, true)
      const approved = await context.ui.confirm(
        failureReason === undefined ? 'Permission escalation' : '⚠ Permission review unavailable',
        failureReason === undefined ? details.message : `⚠ ${failureReason}\n\n${details.message}`,
      )
      reviewLog.review('permission.human_decision', {
        requestId: details.requestId, toolName: details.toolName, humanDecision: approved ? 'APPROVED' : 'REJECTED',
      })
      return approved ? {} : { block: true, reason: 'Permission rejected by user.' }
    } catch (error) {
      reviewLog.review('permission.error', { requestId: details.requestId, toolName: details.toolName, errorCategory: 'confirmation-error' })
      return { block: true, reason: 'Human confirmation failed; permission was not granted.' }
    } finally {
      emitPermissionConfirmation(pi, details.requestId, false)
    }
  }

  function applyConfig(result: LoadConfigResult): AutoReviewActivationResult {
    reportIssues(result)
    if (sessionRuntime === undefined) {
      return { kind: 'failed', message: 'the Pi session has not started' }
    }
    if (result.config === undefined) {
      return {
        kind: 'failed',
        message: 'the merged config is invalid; the previous reviewer remains active',
      }
    }

    let candidate: ReviewerGeneration | undefined
    try {
      candidate = createGeneration(result.config)
    } catch (error) {
      return {
        kind: 'failed',
        message: `failed to create the new reviewer: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (candidate === undefined) {
      return { kind: 'failed', message: 'the Pi session has not started' }
    }

    const previous = generation
    generation = candidate
    previous?.controller.abort()
    return { kind: 'active' }
  }

  pi.on('session_start', (_event, context) => {
    generation?.controller.abort()
    sessionId = randomUUID()
    sessionRuntime = {
      cwd: context.cwd,
      registry: context.modelRegistry,
      sessionManager: context.sessionManager,
    }

    reviewLog.review('permission.session_start', { value: context.cwd })
    const result = loadConfig(context.cwd)
    reportIssues(result)
    try {
      generation = createGeneration(result.config)
    } catch (error) {
      generation = undefined
      ignoreDiagnostic(`failed to create reviewer: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  pi.on('tool_call', handleToolCall)


  pi.on('session_shutdown', () => {
    reviewLog.review('permission.session_shutdown')
    generation?.controller.abort()
    generation = undefined
    sessionRuntime = undefined
  })

  registerAutoReviewCommand(pi, {
    configStore,
    getActiveConfig: () => generation?.config,
    applyConfig,
  })
}

export function createAutoReviewExtension(pi: ExtensionAPI, dependencies: AutoReviewExtensionDependencies = {}): void {
  installAutoReviewExtension(pi, new AutoReviewConfigStore(), dependencies)
}

export function createAutoReviewExtensionWithConfigStore(
  pi: ExtensionAPI,
  configStore: AutoReviewConfigStore,
  dependencies: AutoReviewExtensionDependencies = {},
): void {
  installAutoReviewExtension(pi, configStore, dependencies)
}
