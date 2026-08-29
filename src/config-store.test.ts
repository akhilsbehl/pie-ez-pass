import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutoReviewConfigStore } from './config-store.js'

describe('AutoReviewConfigStore save', () => {
  it('updates a global config symlink target without replacing the symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-review-config-'))
    const agentDir = join(root, 'agent')
    const store = new AutoReviewConfigStore({ agentDir })
    const globalPath = store.getPaths(root).globalPath
    const target = join(root, 'shared-config.json')
    writeFileSync(target, '{}\n')
    mkdirSync(join(agentDir, 'extensions', 'pie-permission-auto-review-codex'), { recursive: true })
    symlinkSync(target, globalPath)

    const result = store.save(store.readScope(root, 'global'), { timeoutMs: 1234 })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).timeoutMs).toBe(1234)
    expect(lstatSync(globalPath).isSymbolicLink()).toBe(true)
  })
})
