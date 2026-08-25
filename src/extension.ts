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

interface ReviewerFactoryOptions {
  config: AutoReviewConfig
  registry: ModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
  sessionSignal: AbortSignal
}

export interface AutoReviewExtensionDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult
  createReviewer?: (options: ReviewerFactoryOptions) => ReviewAuthorizer
}

interface ReviewerGeneration {
  config: AutoReviewConfig | undefined
  controller: AbortController
  authorize: ReviewAuthorizer
}

interface SessionRuntime {
  registry: ModelRegistry
  sessionManager: Pick<SessionManager, 'buildContextEntries'>
}

const REVIEWED_TOOLS = new Set(['bash', 'edit', 'write'])
const MAX_REDIRECTIONS_PER_NEGOTIATION = 3

function ignoreDiagnostic(_message: string): void {
  // The extension is silent during normal operation. Escalation is the user-visible boundary.
}

const reviewLog: ReviewLog = {
  review: () => undefined,
  debug: () => undefined,
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
      outcome: 'escalate',
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

  let sessionRuntime: SessionRuntime | undefined
  let generation: ReviewerGeneration | undefined
  let redirectionsInNegotiation = 0

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

    const current = generation
    if (current === undefined || current.config === undefined) {
      return {
        block: true,
        reason: 'Automatic permission review is unavailable because its configuration is invalid.',
      }
    }

    const details = buildPermissionDetails(event)
    let verdict: Awaited<ReturnType<ReviewAuthorizer>>
    try {
      verdict = await current.authorize(details, reviewLog)
    } catch (error) {
      ignoreDiagnostic(`review failed: ${error instanceof Error ? error.message : String(error)}`)
      verdict = { kind: 'escalate' }
    }

    if (verdict.kind === 'allow') {
      redirectionsInNegotiation = 0
      return {}
    }

    if (verdict.kind === 'redirect' && redirectionsInNegotiation < MAX_REDIRECTIONS_PER_NEGOTIATION) {
      redirectionsInNegotiation += 1
      return {
        block: true,
        reason: `Automatic review requires a narrower action: ${verdict.message}`,
      }
    }

    if (verdict.kind === 'redirect') {
      details.message = `${details.message}\n\nThe model proposed a narrower alternative three times without resolving the request.\nSuggested alternative: ${verdict.message}`
    }

    if (!context.hasUI) {
      redirectionsInNegotiation = 0
      return {
        block: true,
        reason: 'Automatic review could not obtain user confirmation in this Pi mode.',
      }
    }

    try {
      const approved = await context.ui.confirm('Permission escalation', details.message)
      redirectionsInNegotiation = 0
      if (approved) {
        return {}
      }
    } catch (error) {
      ignoreDiagnostic(`permission confirmation failed: ${error instanceof Error ? error.message : String(error)}`)
      redirectionsInNegotiation = 0
    }

    return { block: true, reason: 'Permission denied by user.' }
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
    redirectionsInNegotiation = 0
    return { kind: 'active' }
  }

  pi.on('session_start', (_event, context) => {
    generation?.controller.abort()
    redirectionsInNegotiation = 0
    sessionRuntime = {
      registry: context.modelRegistry,
      sessionManager: context.sessionManager,
    }

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

  pi.on('turn_start', () => {
    // Redirect negotiations can span multiple Pi turns.
  })

  pi.on('session_shutdown', () => {
    generation?.controller.abort()
    generation = undefined
    sessionRuntime = undefined
    redirectionsInNegotiation = 0
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
