import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAutoReviewJsonSchema, autoReviewConfigSchema } from './config.js'

describe('tracked canonical configuration artifacts', () => {
  it('keeps JSON schema synchronized with runtime types and example config valid', () => {
    const schema = JSON.parse(readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'))
    expect(schema).toEqual(buildAutoReviewJsonSchema())
    expect(schema.required).toEqual(['reviewer'])
    expect(schema.additionalProperties).toBe(false)
    const example = JSON.parse(readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'))
    expect(autoReviewConfigSchema.safeParse(example).success).toBe(true)
    expect(example.timeoutMs).toBe(30000)
  })
})
