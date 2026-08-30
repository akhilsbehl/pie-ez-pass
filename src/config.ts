import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { z } from 'zod'

export const EXTENSION_ID = 'pie-permission-auto-review-codex'
export const DEFAULT_PROVIDER = 'openai-codex'
export const DEFAULT_MODEL = 'codex-auto-review'
export const DEFAULT_TIMEOUT_MS = 90_000
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/akhilsbehl/pie-permission-auto-review-codex/master/schemas/config.schema.json'

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const DEFAULT_RULES = {
  allow: { commands: [], paths: [] },
  block: { commands: [], paths: [] },
}

const ruleListSchema = z.array(z.string().trim().min(1)).default([])
const ruleSideSchema = z.strictObject({ commands: ruleListSchema, paths: ruleListSchema })
const rulesSchema = z.strictObject({
  allow: ruleSideSchema.default({ commands: [], paths: [] }),
  block: ruleSideSchema.default({ commands: [], paths: [] }),
})

const configFileShape = {
  $schema: z.string().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoning: z.enum(REASONING_LEVELS).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  additionalPolicy: z.string().trim().min(1).optional(),
}

const autoReviewConfigFileSchema = z.strictObject({ ...configFileShape, rules: rulesSchema.optional() })
const projectConfigFileSchema = z.strictObject(configFileShape)

export const autoReviewConfigSchema = z
  .strictObject({
    ...configFileShape,
    provider: z.string().trim().min(1).default(DEFAULT_PROVIDER),
    model: z.string().trim().min(1).default(DEFAULT_MODEL),
    reasoning: z.enum(REASONING_LEVELS).default('low'),
    timeoutMs: z.number().int().positive().max(300_000).default(DEFAULT_TIMEOUT_MS),
    rules: rulesSchema.default(() => structuredClone(DEFAULT_RULES)),
  })

type ParsedAutoReviewConfig = z.infer<typeof autoReviewConfigSchema>
export type AutoReviewConfig = Omit<ParsedAutoReviewConfig, 'rules'> & { rules?: ParsedAutoReviewConfig['rules'] }

export interface AutoReviewConfigFile {
  $schema?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  reasoning?: (typeof REASONING_LEVELS)[number] | undefined
  timeoutMs?: number | undefined
  additionalPolicy?: string | undefined
  rules?: { allow: { commands: string[]; paths: string[] }; block: { commands: string[]; paths: string[] } } | undefined
}

export interface ConfigIssue {
  sourcePath: string
  message: string
}

export interface LoadConfigResult {
  config: AutoReviewConfig | undefined
  issues: ConfigIssue[]
  globalPath: string
  projectPath: string
}

export interface LoadConfigOptions {
  cwd: string
  agentDir?: string
  readFile?: (path: string) => string | undefined
}

export interface AutoReviewConfigPaths {
  globalPath: string
  projectPath: string
}

export type ParseAutoReviewConfigFileResult =
  | { ok: true; config: AutoReviewConfigFile }
  | { ok: false; issue: ConfigIssue }

export function defaultAutoReviewAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

export function getAutoReviewConfigPaths(
  cwd: string,
  agentDir: string = defaultAutoReviewAgentDir(),
): AutoReviewConfigPaths {
  return {
    globalPath: join(agentDir, 'extensions', EXTENSION_ID, 'config.json'),
    projectPath: join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function formatZodIssue(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export function validateAutoReviewConfigFile(value: unknown, sourcePath: string): ParseAutoReviewConfigFileResult {
  const parsed = autoReviewConfigFileSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      issue: {
        sourcePath,
        message: formatZodIssue(parsed.error),
      },
    }
  }
  return { ok: true, config: parsed.data }
}

export function parseAutoReviewConfigFile(source: string, sourcePath: string): ParseAutoReviewConfigFileResult {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issue: {
        sourcePath,
        message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  return validateAutoReviewConfigFile(value, sourcePath)
}

function readScope(
  path: string,
  readFile: (path: string) => string | undefined,
  issues: ConfigIssue[],
  project = false,
): AutoReviewConfigFile | undefined {
  let source: string | undefined
  try {
    source = readFile(path)
  } catch (error) {
    issues.push({
      sourcePath: path,
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }

  if (source === undefined) {
    return {}
  }

  const parsed = project
    ? (() => {
        let value: unknown
        try { value = JSON.parse(source) } catch (error) { return { ok: false as const, issue: { sourcePath: path, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` } } }
        const result = projectConfigFileSchema.safeParse(value)
        return result.success ? { ok: true as const, config: result.data } : { ok: false as const, issue: { sourcePath: path, message: formatZodIssue(result.error) } }
      })()
    : parseAutoReviewConfigFile(source, path)
  if (!parsed.ok) {
    issues.push(parsed.issue)
    return undefined
  }
  return parsed.config
}

export function loadAutoReviewConfig(options: LoadConfigOptions): LoadConfigResult {
  const { globalPath, projectPath } = getAutoReviewConfigPaths(options.cwd, options.agentDir)
  const readFile = options.readFile ?? defaultReadFile
  const issues: ConfigIssue[] = []
  const globalConfig = readScope(globalPath, readFile, issues)
  const projectConfig = readScope(projectPath, readFile, issues, true)

  if (globalConfig === undefined || projectConfig === undefined) {
    return { config: undefined, issues, globalPath, projectPath }
  }

  const merged = autoReviewConfigSchema.safeParse({
    ...globalConfig,
    ...projectConfig,
  })
  if (!merged.success) {
    issues.push({
      sourcePath: projectPath,
      message: formatZodIssue(merged.error),
    })
    return { config: undefined, issues, globalPath, projectPath }
  }

  const config = normalizeAndValidateRules(merged.data, options.cwd, globalPath, issues)
  return {
    config,
    issues,
    globalPath,
    projectPath,
  }
}

function normalizeAndValidateRules(config: ParsedAutoReviewConfig, cwd: string, sourcePath: string, issues: ConfigIssue[]): AutoReviewConfig | undefined {
  const normalizeCommands = (values: string[]) => [...new Set(values.map(value => value.trim()))]
  const expandPath = (value: string): string | undefined => {
    if (value === '$CWD') return resolve(cwd)
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
    return isAbsolute(value) ? resolve(value) : undefined
  }
  const allowCommands = normalizeCommands(config.rules.allow.commands)
  const blockCommands = normalizeCommands(config.rules.block.commands)
  if (allowCommands.some(pattern => blockCommands.includes(pattern))) {
    issues.push({ sourcePath, message: 'identical normalized command patterns across allow and block are invalid' })
    return undefined
  }
  const allowPathRules = [...new Set(config.rules.allow.paths)]
  const blockPathRules = [...new Set(config.rules.block.paths)]
  const allowPaths = allowPathRules.map(expandPath)
  const blockPaths = blockPathRules.map(expandPath)
  if (allowPaths.includes(undefined) || blockPaths.includes(undefined)) {
    issues.push({ sourcePath, message: 'path rules must be absolute, ~/..., or exact $CWD' })
    return undefined
  }
  const allows = allowPaths as string[]
  const blocks = blockPaths as string[]
  if (allows.some(allow => blocks.some(block => allow === block))) {
    issues.push({ sourcePath, message: 'equal allow and block paths are invalid' })
    return undefined
  }
  const canonical = (path: string): string | undefined => {
    try { return realpathSync(path) } catch { return undefined }
  }
  const allowCanonical = allows.map(canonical).filter((path): path is string => path !== undefined)
  const blockCanonical = blocks.map(canonical).filter((path): path is string => path !== undefined)
  if (allowCanonical.some(allow => blockCanonical.includes(allow))) {
    issues.push({ sourcePath, message: 'equal allow and block canonical path aliases are invalid' })
    return undefined
  }
  return { ...config, rules: { allow: { commands: allowCommands, paths: allowPathRules }, block: { commands: blockCommands, paths: blockPathRules } } }
}

export function buildAutoReviewJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(autoReviewConfigSchema, {
    target: 'draft-2020-12',
    io: 'input',
  })
  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
