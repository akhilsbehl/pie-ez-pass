import type { Api, ClassifierApi, ClassifierModel, Model } from '@earendil-works/pi-ai'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SYS2_MODEL, DEFAULT_SYS2_PROVIDER } from './config.js'
import type { AutoReviewConfig, ReviewPath } from './config.js'

export type ReviewModelRegistry = Pick<ModelRegistry,
  'findOfType' | 'getModelsOfType' | 'getAvailableOfType' | 'classify' | 'streamSimple' | 'refresh'>

export interface ModelIdentity { provider: string; id: string }
export type ReviewModel = Model<Api> | ClassifierModel<ClassifierApi>
export type ModelAvailability = 'available' | 'available-hidden-alias' | 'unavailable-auth' | 'unknown-model' | 'discovery-error'

export function sameModel(left: ModelIdentity, right: ModelIdentity): boolean {
  return left.provider === right.provider && left.id === right.id
}

export function modelSearchText(model: ModelIdentity & { name: string }): string {
  return `${model.provider} ${model.provider}/${model.id} ${model.id} ${model.name}`
}

export function configuredModel(config: AutoReviewConfig, path: ReviewPath): ModelIdentity {
  return path === 'sys1'
    ? { provider: config.sys1_provider, id: config.sys1_model }
    : { provider: config.sys2_provider, id: config.sys2_model }
}

// The sole compatibility exception: OpenAI's hidden, user-approved reviewer ID.
// Do not register it globally or change Pi's conversation-model catalog.
export function withCodexAlias(models: readonly Model<Api>[]): Model<Api>[] {
  if (models.some(model => model.provider === DEFAULT_SYS2_PROVIDER && model.id === DEFAULT_SYS2_MODEL)) return [...models]
  const template = models.find(model => model.provider === DEFAULT_SYS2_PROVIDER && model.api === 'openai-codex-responses')
  return template === undefined ? [...models] : [...models, {
    ...template, id: DEFAULT_SYS2_MODEL, name: 'Codex Auto Review (hidden)', reasoning: true, input: ['text'],
  }]
}

export function resolveSys1Model(registry: ReviewModelRegistry, identity: ModelIdentity): ClassifierModel<ClassifierApi> | undefined {
  const model = registry.findOfType('classifier', identity.provider, identity.id)
  return model?.type === 'classifier' ? model : undefined
}

export function resolveSys2Model(registry: ReviewModelRegistry, identity: ModelIdentity): Model<Api> | undefined {
  return withCodexAlias(registry.getModelsOfType('chat')).find(model => sameModel(model, identity))
}

export async function availableReviewModels(
  registry: ReviewModelRegistry, path: ReviewPath, signal: AbortSignal, provider?: string,
): Promise<ReviewModel[]> {
  if (path === 'sys1') return [...await registry.getAvailableOfType('classifier', provider, { signal })]
  return withCodexAlias(await registry.getAvailableOfType('chat', provider, { signal }))
}

export async function modelAvailability(
  registry: ReviewModelRegistry, path: ReviewPath, identity: ModelIdentity, signal: AbortSignal,
): Promise<ModelAvailability> {
  const model = path === 'sys1' ? resolveSys1Model(registry, identity) : resolveSys2Model(registry, identity)
  if (model === undefined) return 'unknown-model'
  const available = await availableReviewModels(registry, path, signal, identity.provider)
  if (!available.some(entry => sameModel(entry, identity))) return 'unavailable-auth'
  const physical = registry.getModelsOfType(path === 'sys1' ? 'classifier' : 'chat').some(entry => sameModel(entry, identity))
  return physical ? 'available' : 'available-hidden-alias'
}
