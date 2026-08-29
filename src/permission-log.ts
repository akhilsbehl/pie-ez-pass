import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync, constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReviewLog } from './review-types.js'

export const PERMISSION_LOG_PATH = join(homedir(), '.pi', 'agent', 'runtime', 'review-permission-logs.jsonl')
const MAX_PREVIEW_LENGTH = 2_000
const SENSITIVE_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|Bearer\s+[^\s"']+|\S+)/gi
const BEARER_TOKEN = /\bBearer\s+[^\s"']+/gi

export interface PermissionLogRecord {
  schemaVersion: 1
  timestamp: string
  sessionId?: string
  event: string
  requestId?: string
  toolCallId?: string
  toolName?: string
  operation?: string
  requestSummary?: string
  policy?: string
  outcome?: string
  humanDecision?: string
  rationale?: string
  provider?: string
  model?: string
  errorCategory?: string
  reasonCode?: string
  durationMs?: number
  inputKeys?: string[]
  inputSha256?: string
  valueSha256?: string
}

function sha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return createHash('sha256').update(value).digest('hex')
}

function safePreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const redacted = value
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(
      SENSITIVE_ASSIGNMENT,
      (_match: string, key: string, separator: string, secret: string) => {
        if (secret === 'Bearer [REDACTED]') return `${key}${separator}${secret}`
        const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : ''
        return `${key}${separator}${quote}[REDACTED]${quote}`
      },
    )
  return redacted.length > MAX_PREVIEW_LENGTH ? `${redacted.slice(0, MAX_PREVIEW_LENGTH)}…` : redacted
}

/** Append-only, best-effort logger. Logging must never change the permission decision. */
export function createPermissionLog(filePath = PERMISSION_LOG_PATH): ReviewLog {
  const append = (event: string, details: Record<string, unknown> = {}): void => {
    const record: PermissionLogRecord = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      event,
    }
    const copyString = (key: keyof PermissionLogRecord, preview = false): void => {
      const value = details[key]
      const copied = preview ? safePreview(value) : value
      if (typeof copied === 'string' && copied.length > 0) record[key] = copied as never
    }
    for (const key of [
      'sessionId',
      'requestId',
      'toolCallId',
      'toolName',
      'operation',
      'policy',
      'outcome',
      'humanDecision',
      'provider',
      'model',
      'errorCategory',
      'reasonCode',
    ] as const) {
      copyString(key)
    }
    for (const key of ['requestSummary', 'rationale'] as const) {
      copyString(key, true)
    }
    if (typeof details.durationMs === 'number' && Number.isFinite(details.durationMs)) record.durationMs = details.durationMs
    if (Array.isArray(details.inputKeys)) {
      record.inputKeys = details.inputKeys
        .filter((key): key is string => typeof key === 'string')
        .slice(0, 100)
    }
    record.inputSha256 = sha256(details.toolInputPreview)
    record.valueSha256 = sha256(details.value)
    if (record.inputSha256 === undefined) delete record.inputSha256
    if (record.valueSha256 === undefined) delete record.valueSha256

    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      try {
        chmodSync(dirname(filePath), 0o700)
      } catch {
        // Directory permissions are best effort.
      }
      // O_APPEND makes each write append rather than replace existing history.
      const fd = openSync(filePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
      try {
        appendFileSync(fd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
        try {
          chmodSync(filePath, 0o600)
        } catch {
          // File permissions are best effort.
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // Permission enforcement is fail-closed elsewhere; telemetry is not authoritative.
    }
  }
  return { review: append, debug: append }
}
