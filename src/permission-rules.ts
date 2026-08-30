import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { DEFAULT_RULES, type AutoReviewConfig } from './config.js'

export type PermanentRuleDecision = 'allow' | 'block' | 'conflict' | 'none'

function commandMatches(pattern: string, command: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(command.trim())
}

function expandRoot(rule: string, cwd: string): string {
  if (rule === '$CWD') return resolve(cwd)
  if (rule === '~') return homedir()
  if (rule.startsWith('~/')) return resolve(homedir(), rule.slice(2))
  return resolve(rule)
}

function within(root: string, target: string): boolean {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

export function decidePermanentRule(toolName: string, value: string | undefined, config: AutoReviewConfig, cwd: string): PermanentRuleDecision {
  if (value === undefined) return 'none'
  let allowed: boolean
  let blocked: boolean
  const rules = config.rules ?? DEFAULT_RULES
  if (toolName === 'bash') {
    allowed = rules.allow.commands.some(pattern => commandMatches(pattern, value))
    blocked = rules.block.commands.some(pattern => commandMatches(pattern, value))
  } else if (toolName === 'edit' || toolName === 'write') {
    const target = resolve(cwd, value)
    allowed = rules.allow.paths.some(rule => within(expandRoot(rule, cwd), target))
    blocked = rules.block.paths.some(rule => within(expandRoot(rule, cwd), target))
  } else return 'none'
  if (allowed && blocked) return toolName === 'bash' ? 'conflict' : 'block'
  if (blocked) return 'block'
  if (allowed) return 'allow'
  return 'none'
}
