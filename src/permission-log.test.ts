import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPermissionLog } from './permission-log.js'

describe('persistent permission log', () => {
  it('appends privacy-safe JSONL records and preserves prior records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'permission-log-'))
    const path = join(directory, 'runtime', 'review-permission-logs.jsonl')
    const log = createPermissionLog(path)

    log.review('permission.tool_call', {
      requestId: 'request-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      toolInputPreview: '{"command":"curl --header \\\"Authorization: Bearer secret-token\\\" https://example.test"}',
      inputKeys: ['command'],
      requestSummary: 'curl --header "Authorization: Bearer secret-token" https://example.test',
      value: 'cat secret.txt',
    })
    log.review('auto_review.decision', {
      requestId: 'request-1',
      toolName: 'bash',
      outcome: 'escalate',
      riskLevel: 'high',
      userAuthorization: 'unknown',
      rationale: 'The command uses a bearer token=secret-token.',
      redirect: 'Use a narrower target.',
      durationMs: 42,
    })
    log.review('permission.user_decision', { requestId: 'request-1', outcome: 'denied' })
    log.review('permission.blocked', { requestId: 'request-1', reasonCode: 'user-denied' })
    log.debug('auto_review.failure', { requestId: 'request-1', errorCategory: 'provider-error' })

    const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatchObject({ schemaVersion: 1, event: 'permission.tool_call', requestId: 'request-1', toolName: 'bash', inputKeys: ['command'] })
    expect(lines[0]).toHaveProperty('inputSha256')
    expect(lines[0]).toHaveProperty('valueSha256')
    expect(lines[0]).toHaveProperty('requestSummary', 'curl --header "Authorization: Bearer [REDACTED]" https://example.test')
    expect(JSON.stringify(lines[0])).not.toContain('secret.txt')
    expect(JSON.stringify(lines[0])).not.toContain('secret-token')
    expect(lines[1]).toMatchObject({
      event: 'auto_review.decision',
      outcome: 'escalate',
      riskLevel: 'high',
      rationale: 'The command uses a Bearer [REDACTED]',
      redirect: 'Use a narrower target.',
      durationMs: 42,
    })
    expect(lines[2]).toMatchObject({ event: 'permission.user_decision', outcome: 'denied' })
    expect(lines[3]).toMatchObject({ event: 'permission.blocked', reasonCode: 'user-denied' })
    expect(lines[4]).toMatchObject({ event: 'auto_review.failure', errorCategory: 'provider-error' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'runtime')).mode & 0o777).toBe(0o700)
  })

  it('does not throw when the log cannot be written', () => {
    const log = createPermissionLog('/proc/permission-log.jsonl')
    expect(() => log.review('permission.error', { errorCategory: 'test' })).not.toThrow()
  })
})
