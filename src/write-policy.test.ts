import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isDeterministicallyAllowedWritePath } from './write-policy.js'

describe('deterministic write policy', () => {
  const cwd = '/workspace/project'

  it('allows the session working directory and nested paths', () => {
    expect(isDeterministicallyAllowedWritePath(cwd, cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('src/index.ts', cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('../other/index.ts', cwd)).toBe(false)
    expect(isDeterministicallyAllowedWritePath('/workspace/project-other/index.ts', cwd)).toBe(false)
  })

  it('allows the fixed operator directories recursively', () => {
    expect(isDeterministicallyAllowedWritePath('/tmp/output.txt', cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('~/tmp/output.txt', cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('~/.richie/output.txt', cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('~/.pi/output.txt', cwd)).toBe(true)
    expect(isDeterministicallyAllowedWritePath('~/warchives/output.txt', cwd)).toBe(true)
  })

  it('does not treat a sibling of an allowed home directory as allowed', () => {
    expect(isDeterministicallyAllowedWritePath(`${homedir()}/.pione/file`, cwd)).toBe(false)
  })

  it('rejects empty paths', () => {
    expect(isDeterministicallyAllowedWritePath('', cwd)).toBe(false)
  })
})
