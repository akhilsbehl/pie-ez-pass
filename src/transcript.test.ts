import { describe, expect, it } from 'vitest'
import { renderTranscript, truncateToApproximateTokens } from './transcript.js'
import { buildSys1State, buildReviewPrompt } from './prompt.js'
import { testConfig, requestDetails } from './reviewer-test-fixtures.js'

const message = (role: string, content: unknown, id: number) => ({ type: 'message', id: String(id), message: { role, content }, timestamp: '', parentId: null })
describe('unchanged bounded text evidence for both paths', () => {
  it('omits image bytes and preserves surrounding user text for either reviewer', () => {
    const transcript = renderTranscript([message('user', [{ type: 'text', text: 'Explicit user request' }, { type: 'image', data: 'SECRET-BASE64', mimeType: 'image/png' }], 0)] as never)
    expect(transcript.entries[0]).toContain('[image omitted]')
    for (const text of [buildSys1State(testConfig('sys1'), transcript, requestDetails()), buildReviewPrompt(testConfig(), transcript, requestDetails()).userPrompt]) {
      expect(text).toContain('Explicit user request'); expect(text).toContain('[image omitted]'); expect(text).not.toContain('SECRET-BASE64')
    }
  })
  it('retains first/latest user evidence, caps entries and keeps existing truncation markers', () => {
    const entries = Array.from({ length: 100 }, (_, i) => message(i === 0 || i === 99 ? 'user' : 'assistant', i === 0 ? 'FIRST' : i === 99 ? 'LAST' : 'x'.repeat(10000), i))
    const rendered = renderTranscript(entries as never)
    expect(rendered.entries.length).toBeLessThanOrEqual(40)
    expect(rendered.entries.join('\n')).toContain('FIRST')
    expect(rendered.entries.join('\n')).toContain('LAST')
    expect(rendered.omittedCount).toBeGreaterThan(0)
    expect(truncateToApproximateTokens('x'.repeat(10000), 2000)).toContain('...[truncated]...')
    expect(truncateToApproximateTokens('x'.repeat(10000), 2000)).toHaveLength(8000)
  })
})
