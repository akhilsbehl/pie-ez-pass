import type { AutoReviewConfigStore, AutoReviewConfigScope, AutoReviewScopeSnapshot } from './config-store.js'
import type { AutoReviewConfigFile, LoadConfigResult, ReviewPath } from './config.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_SYS1_ESCALATE_THRESHOLD, DEFAULT_SYS1_MODEL, DEFAULT_SYS1_PROVIDER,
  DEFAULT_SYS2_MODEL, DEFAULT_SYS2_PROVIDER, DEFAULT_TIMEOUT_MS, REASONING_LEVELS, autoReviewConfigSchema,
} from './config.js'
import type { ModelIdentity } from './model.js'
import { availableReviewModels, modelAvailability, sameModel } from './model.js'
import { pickReviewModel } from './model-picker.js'
import { createReviewDeadline, raceWithSignal } from './review-deadline.js'

const COMMAND_NAME = 'ez-pass'
const USAGE = 'Usage: /ez-pass [show|path|help]'
const INHERIT = 'Use inherited value'
const SAVE = 'Save changes'
const CANCEL = 'Cancel'
const DEFAULT_CONFIG = {
  sys1_provider: DEFAULT_SYS1_PROVIDER, sys1_model: DEFAULT_SYS1_MODEL,
  sys2_provider: DEFAULT_SYS2_PROVIDER, sys2_model: DEFAULT_SYS2_MODEL, sys2_reasoning: 'low' as const,
  timeoutMs: DEFAULT_TIMEOUT_MS, sys1_escalate_threshold: DEFAULT_SYS1_ESCALATE_THRESHOLD,
}
const configFields = [
  'reviewer', 'sys1_provider', 'sys1_model', 'sys2_provider', 'sys2_model',
  'sys1_escalate_threshold', 'sys2_reasoning', 'timeoutMs', 'additionalPolicy',
] as const
const menuFields = ['reviewer', 'sys1', 'sys2', 'sys1_escalate_threshold', 'sys2_reasoning', 'timeoutMs', 'additionalPolicy'] as const

type ConfigField = (typeof configFields)[number]
type ConfigLayers = Record<AutoReviewConfigScope, AutoReviewConfigFile>
const fieldLabels = {
  reviewer: 'Reviewer', sys1: 'sys1 model', sys2: 'sys2 model',
  sys1_escalate_threshold: 'sys1 escalation probability threshold', sys2_reasoning: 'sys2 reasoning',
  timeoutMs: 'Timeout', additionalPolicy: 'Additional policy',
}

export type AutoReviewActivationResult = { kind: 'active' } | { kind: 'pending' } | { kind: 'failed'; message: string }
export interface AutoReviewCommandController {
  configStore: AutoReviewConfigStore
  applyConfig: (result: LoadConfigResult) => AutoReviewActivationResult
}

function resolveView(layers: ConfigLayers): AutoReviewConfigFile {
  const merged = { ...DEFAULT_CONFIG, ...layers.global, ...layers.project }
  const parsed = autoReviewConfigSchema.safeParse(merged)
  return parsed.success ? parsed.data : merged
}
function resolveOrigin(layers: ConfigLayers, field: ConfigField): AutoReviewConfigScope | 'default' {
  return Object.hasOwn(layers.project, field) ? 'project' : Object.hasOwn(layers.global, field) ? 'global' : 'default'
}
function formatValue(field: ConfigField, value: unknown): string {
  if (field === 'additionalPolicy') return value ? 'configured' : 'not set'
  if (field === 'timeoutMs') return `${value} ms`
  return String(value ?? 'not set (required)')
}
function removeField(config: AutoReviewConfigFile, field: ConfigField): AutoReviewConfigFile {
  const next = { ...config }; delete next[field]; return next
}
function pair(view: AutoReviewConfigFile, path: ReviewPath): ModelIdentity {
  return { provider: String(view[`${path}_provider`]), id: String(view[`${path}_model`]) }
}
function pairOrigin(layers: ConfigLayers, path: ReviewPath): string {
  return `provider: ${resolveOrigin(layers, `${path}_provider`)}; model: ${resolveOrigin(layers, `${path}_model`)}`
}
function buildLayers(selected: AutoReviewScopeSnapshot, other: AutoReviewScopeSnapshot, draft: AutoReviewConfigFile): ConfigLayers | undefined {
  if (!selected.valid || !other.valid) return undefined
  return selected.scope === 'global' ? { global: draft, project: other.config } : { global: other.config, project: draft }
}

async function editModel(ctx: ExtensionCommandContext, draft: AutoReviewConfigFile, path: ReviewPath, layers: ConfigLayers, scope: AutoReviewConfigScope) {
  const providerKey = `${path}_provider` as const
  const modelKey = `${path}_model` as const
  const inheritedLayer = { ...layers[scope] }; delete inheritedLayer[providerKey]; delete inheritedLayer[modelKey]
  const inherited = resolveView({ ...layers, [scope]: inheritedLayer })
  const selected = await pickReviewModel(ctx, path, pair(resolveView(layers), path), pair(inherited, path))
  if (selected === undefined) return { draft }
  const next = { ...draft }; delete next[providerKey]; delete next[modelKey]
  if (selected.kind === 'inherit') return { draft: next, changed: true }
  return { draft: { ...next, [providerKey]: selected.model.provider, [modelKey]: selected.model.id }, changed: true, model: selected.model }
}

async function editNumber(ctx: ExtensionCommandContext, draft: AutoReviewConfigFile, field: 'timeoutMs' | 'sys1_escalate_threshold', current: number) {
  const action = await ctx.ui.select(`Configure ${fieldLabels[field]}`, [INHERIT, 'Enter value...'])
  if (action === INHERIT) return removeField(draft, field)
  if (action !== 'Enter value...') return draft
  const source = await ctx.ui.input(field, String(current))
  if (source === undefined) return draft
  const value = source.trim().length ? Number(source.trim()) : NaN
  if (field === 'timeoutMs' ? !Number.isInteger(value) || value < 1 || value > 300_000 : !Number.isFinite(value) || value < 0 || value > 1) {
    ctx.ui.notify(field === 'timeoutMs' ? 'timeoutMs must be an integer between 1 and 300000.' : 'sys1_escalate_threshold must be a number from 0 through 1.', 'warning')
    return draft
  }
  return { ...draft, [field]: value }
}

async function openSettingsMenu(ctx: ExtensionCommandContext, controller: AutoReviewCommandController): Promise<void> {
  if (ctx.mode !== 'tui') { ctx.ui.notify(`/${COMMAND_NAME} requires interactive TUI mode.`, 'warning'); return }
  await ctx.waitForIdle()
  const selection = await ctx.ui.select('Select configuration scope', ['Global configuration', 'Project configuration'])
  const scope = selection === 'Global configuration' ? 'global' : selection === 'Project configuration' ? 'project' : undefined
  if (scope === undefined) return
  const selected = controller.configStore.readScope(ctx.cwd, scope)
  const other = controller.configStore.readScope(ctx.cwd, scope === 'global' ? 'project' : 'global')
  for (const snapshot of [selected, other]) {
    if (!snapshot.valid) { ctx.ui.notify(`Cannot edit config at '${snapshot.path}': ${snapshot.issue.message}. Fix it manually.`, 'error'); return }
  }
  if (!selected.valid) return
  let draft: AutoReviewConfigFile = { ...selected.config }
  const newChoices = new Map<ReviewPath, ModelIdentity>()
  while (true) {
    const layers = buildLayers(selected, other, draft)
    if (layers === undefined) return
    const view = resolveView(layers)
    const fieldOptions = menuFields.map(field => {
      if (field === 'sys1' || field === 'sys2') {
        const model = pair(view, field)
        const overrides = `${field}_provider` in draft || `${field}_model` in draft
        return `${fieldLabels[field]}: ${model.provider}/${model.id} (${pairOrigin(layers, field)}; ${scope}: ${overrides ? 'override' : 'inherit'})`
      }
      return `${fieldLabels[field]}: ${formatValue(field, view[field])} (source: ${resolveOrigin(layers, field)}; ${scope}: ${field in draft ? 'override' : 'inherit'})`
    })
    const action = await ctx.ui.select(`Permission auto-review settings (${scope})`, [...fieldOptions, SAVE, CANCEL])
    if (action === undefined || action === CANCEL) return
    if (action === SAVE) {
      let unavailable = false
      const deadline = createReviewDeadline(15_000)
      try {
        for (const [path, model] of newChoices) {
          const models = await raceWithSignal(availableReviewModels(ctx.modelRegistry, path, deadline.signal, model.provider), deadline.signal)
          if (!models.some(entry => sameModel(entry, model))) { unavailable = true; break }
        }
      } catch { unavailable = true }
      finally { deadline.dispose() }
      if (unavailable) { ctx.ui.notify('A newly selected model is no longer available. Check /login and choose again; config was not saved.', 'warning'); continue }
      const saved = controller.configStore.save(selected, draft)
      if (!saved.ok) { ctx.ui.notify(saved.message, 'error'); continue }
      const activation = controller.applyConfig(saved.loadResult)
      if (activation.kind === 'failed') ctx.ui.notify(`Config saved, but the current reviewer could not be replaced: ${activation.message}`, 'error')
      else if (activation.kind === 'pending') ctx.ui.notify('Config saved. It will become active when the Pi session starts.', 'warning')
      else ctx.ui.notify('Config saved and applied without reloading the Pi session.', 'info')
      return
    }
    const field = menuFields[fieldOptions.indexOf(action)]
    if (field === 'sys1' || field === 'sys2') {
      const result = await editModel(ctx, draft, field, layers, scope)
      draft = result.draft
      if (result.changed) { if (result.model) newChoices.set(field, result.model); else newChoices.delete(field) }
    } else if (field === 'reviewer') {
      const value = await ctx.ui.select('Configure Reviewer', [INHERIT, 'sys1', 'sys2'])
      if (value === INHERIT) draft = removeField(draft, field)
      else if (value === 'sys1' || value === 'sys2') draft = { ...draft, reviewer: value }
    } else if (field === 'sys2_reasoning') {
      const value = await ctx.ui.select('Configure sys2 reasoning', [INHERIT, ...REASONING_LEVELS])
      if (value === INHERIT) draft = removeField(draft, field)
      else { const level = REASONING_LEVELS.find(level => level === value); if (level) draft = { ...draft, sys2_reasoning: level } }
    } else if (field === 'timeoutMs' || field === 'sys1_escalate_threshold') {
      draft = await editNumber(ctx, draft, field, Number(view[field]))
    } else if (field === 'additionalPolicy') {
      const value = await ctx.ui.select('Configure Additional Policy', ['Edit policy...', INHERIT])
      if (value === INHERIT) draft = removeField(draft, field)
      else if (value === 'Edit policy...') {
        const policy = await ctx.ui.editor('Additional review policy', view.additionalPolicy ?? '')
        if (policy !== undefined) draft = policy.trim() ? { ...draft, additionalPolicy: policy.trim() } : removeField(draft, field)
      }
    }
  }
}

async function showConfig(ctx: ExtensionCommandContext, controller: AutoReviewCommandController): Promise<void> {
  // Always reload: never pair stale active values with fresh field provenance.
  const result = controller.configStore.load(ctx.cwd)
  const global = controller.configStore.readScope(ctx.cwd, 'global')
  const project = controller.configStore.readScope(ctx.cwd, 'project')
  if (!result.config || !global.valid || !project.valid) {
    ctx.ui.notify(`Automatic review is disabled because the current config is invalid.\n${result.issues.map(issue => `${issue.sourcePath}: ${issue.message}`).join('\n')}`, 'warning'); return
  }
  const layers = { global: global.config, project: project.config }
  const fields = configFields.map(field => `${field}=${formatValue(field, result.config![field])} (${resolveOrigin(layers, field)})`)
  const deadline = createReviewDeadline(15_000)
  try {
    for (const path of ['sys1', 'sys2'] as const) {
      let status: string = 'discovery-error'
      try { status = await raceWithSignal(modelAvailability(ctx.modelRegistry, path, pair(result.config, path), deadline.signal), deadline.signal) } catch { /* Diagnostics only. */ }
      fields.push(`${path}_availability=${status}`)
    }
  } finally { deadline.dispose() }
  ctx.ui.notify(`ez-pass:\n${fields.join('\n')}\nglobal=${result.globalPath}\nproject=${result.projectPath}`, 'info')
}

export function registerAutoReviewCommand(pi: ExtensionAPI, controller: AutoReviewCommandController): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Configure pie-ez-pass without reloading the Pi session',
    getArgumentCompletions: prefix => {
      const items = [
        { value: 'show', label: 'Show current config', description: 'Display effective values, origins and model availability' },
        { value: 'path', label: 'Show config paths', description: 'Display global and project config paths' },
        { value: 'help', label: 'Show help', description: 'Display command usage' },
      ].filter(item => item.value.startsWith(prefix.trimStart().toLowerCase()))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase()
      if (!action) await openSettingsMenu(ctx, controller)
      else if (action === 'show') await showConfig(ctx, controller)
      else if (action === 'path') {
        const paths = controller.configStore.getPaths(ctx.cwd)
        ctx.ui.notify(`ez-pass config paths:\nglobal=${paths.globalPath}\nproject=${paths.projectPath}`, 'info')
      } else ctx.ui.notify(USAGE, action === 'help' ? 'info' : 'warning')
    },
  })
}
