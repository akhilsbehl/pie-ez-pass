import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createAutoReviewExtension } from './extension.js'

export {
  CONFIG_SCHEMA_URL,
  DEFAULT_SYS1_ESCALATE_THRESHOLD,
  DEFAULT_SYS1_MODEL,
  DEFAULT_SYS1_PROVIDER,
  DEFAULT_SYS2_MODEL,
  DEFAULT_SYS2_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  EXTENSION_ID,
  autoReviewConfigSchema,
  buildAutoReviewJsonSchema,
  loadAutoReviewConfig,
} from './config.js'
export type { AutoReviewConfig, AutoReviewConfigFile, ReviewPath, ConfigIssue, LoadConfigOptions, LoadConfigResult } from './config.js'
export { createAutoReviewExtension } from './extension.js'
export type { AutoReviewExtensionDependencies } from './extension.js'

export default function permissionAutoReviewExtension(pi: ExtensionAPI): void {
  createAutoReviewExtension(pi)
}
