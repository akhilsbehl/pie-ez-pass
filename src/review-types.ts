export interface ReviewPermissionDetails {
  requestId: string
  source: string
  agentName?: string
  message: string
  toolCallId?: string
  toolName?: string
  skillName?: string
  path?: string
  command?: string
  target?: string
  toolInputPreview?: string
  sessionLabel?: string
  surface?: string
  value?: string
  forwarding?: unknown
  sessionApproval?: unknown
  accessIntent?: unknown
}

export interface ReviewLog {
  review(event: string, details?: Record<string, unknown>): void
  debug(event: string, details?: Record<string, unknown>): void
}

export type ReviewVerdict =
  | { kind: 'allow' }
  | { kind: 'redirect'; message: string }
  | { kind: 'escalate' }

export type ReviewAuthorizer = (
  details: ReviewPermissionDetails,
  log: ReviewLog,
) => Promise<ReviewVerdict>
