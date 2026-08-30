import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { DEFAULT_RULES, type AutoReviewConfig } from './config.js'

export type PermanentRuleDecision = 'allow' | 'block' | 'conflict' | 'none'

type Score = readonly number[]

function compareScore(left: Score | undefined, right: Score | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1
  if (right === undefined) return 1
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function commandMatches(pattern: string, command: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(command.trim())
}

function commandScore(pattern: string): Score {
  const stars = [...pattern].filter(character => character === '*').length
  return [stars === 0 ? 1 : 0, pattern.length - stars, -stars]
}

function bestCommand(patterns: string[], command: string): Score | undefined {
  return patterns.reduce<Score | undefined>((best, pattern) => {
    if (!commandMatches(pattern, command)) return best
    const score = commandScore(pattern)
    return compareScore(score, best) > 0 ? score : best
  }, undefined)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return path
}

function expandRoot(rule: string, cwd: string): string {
  if (rule === '$CWD') return resolve(cwd)
  return resolve(expandHome(rule))
}

function resolveExisting(path: string): string | undefined {
  const missing: string[] = []
  let cursor = path
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...missing.reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return undefined
      missing.push(cursor.slice(parent.length + (parent.endsWith('/') ? 0 : 1)))
      cursor = parent
    }
  }
}

function aliases(path: string): string[] {
  const canonical = resolveExisting(path)
  return canonical === undefined || canonical === path ? [path] : [path, canonical]
}

function within(root: string, target: string): boolean {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

function bestPath(patterns: string[], value: string, cwd: string): Score | undefined {
  const targets = aliases(resolve(cwd, expandHome(value)))
  return patterns.reduce<Score | undefined>((best, pattern) => {
    const root = expandRoot(pattern, cwd)
    const rootAliases = aliases(root)
    const matches = rootAliases.some(rootAlias => targets.some(target => within(rootAlias, target)))
    if (!matches) return best
    const specificityRoot = resolveExisting(root) ?? root
    const score: Score = [specificityRoot.split('/').filter(Boolean).length]
    return compareScore(score, best) > 0 ? score : best
  }, undefined)
}

function decide(allow: Score | undefined, block: Score | undefined): PermanentRuleDecision {
  const comparison = compareScore(allow, block)
  if (allow !== undefined && block !== undefined && comparison === 0) return 'conflict'
  if (comparison > 0) return 'allow'
  if (comparison < 0) return 'block'
  return 'none'
}

export function decidePermanentRule(toolName: string, value: string | undefined, config: AutoReviewConfig, cwd: string): PermanentRuleDecision {
  if (value === undefined) return 'none'
  const rules = config.rules ?? DEFAULT_RULES
  if (toolName === 'bash') {
    if (/[;&|\n\r`]/.test(value) || value.includes('$(') || value.includes('<(') || value.includes('>(')) return 'none'
    return decide(bestCommand(rules.allow.commands, value), bestCommand(rules.block.commands, value))
  }
  if (toolName === 'edit' || toolName === 'write') {
    return decide(bestPath(rules.allow.paths, value, cwd), bestPath(rules.block.paths, value, cwd))
  }
  return 'none'
}
