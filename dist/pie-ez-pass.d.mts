import { ExtensionAPI, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
//#region src/config.d.ts
declare const EXTENSION_ID = "pie-ez-pass";
declare const DEFAULT_PROVIDER = "openai-codex";
declare const DEFAULT_MODEL = "codex-auto-review";
declare const DEFAULT_TIMEOUT_MS = 90000;
declare const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/akhilsbehl/pie-ez-pass/refs/heads/master/schemas/config.schema.json";
declare const autoReviewConfigSchema: z.ZodObject<{
  $schema: z.ZodOptional<z.ZodString>;
  additionalPolicy: z.ZodOptional<z.ZodString>;
  provider: z.ZodDefault<z.ZodString>;
  model: z.ZodDefault<z.ZodString>;
  reasoning: z.ZodDefault<z.ZodEnum<{
    high: "high";
    low: "low";
    max: "max";
    medium: "medium";
    minimal: "minimal";
    off: "off";
    xhigh: "xhigh";
  }>>;
  timeoutMs: z.ZodDefault<z.ZodNumber>;
  rules: z.ZodDefault<z.ZodObject<{
    allow: z.ZodDefault<z.ZodObject<{
      commands: z.ZodDefault<z.ZodArray<z.ZodString>>;
      paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    block: z.ZodDefault<z.ZodObject<{
      commands: z.ZodDefault<z.ZodArray<z.ZodString>>;
      paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
  }, z.core.$strict>>;
}, z.core.$strict>;
type ParsedAutoReviewConfig = z.infer<typeof autoReviewConfigSchema>;
type AutoReviewConfig = Omit<ParsedAutoReviewConfig, 'rules'> & {
  rules?: ParsedAutoReviewConfig['rules'];
};
interface ConfigIssue {
  sourcePath: string;
  message: string;
}
interface LoadConfigResult {
  config: AutoReviewConfig | undefined;
  issues: ConfigIssue[];
  globalPath: string;
  projectPath: string;
}
interface LoadConfigOptions {
  cwd: string;
  agentDir?: string;
  readFile?: (path: string) => string | undefined;
}
declare function loadAutoReviewConfig(options: LoadConfigOptions): LoadConfigResult;
declare function buildAutoReviewJsonSchema(): Record<string, unknown>;
//#endregion
//#region src/review-types.d.ts
interface ReviewPermissionDetails {
  requestId: string;
  source: string;
  agentName?: string;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInputPreview?: string;
  sessionLabel?: string;
  surface?: string;
  value?: string;
  forwarding?: unknown;
  sessionApproval?: unknown;
  accessIntent?: unknown;
}
interface ReviewLog {
  review(event: string, details?: Record<string, unknown>): void;
  debug(event: string, details?: Record<string, unknown>): void;
}
type ReviewVerdict = {
  kind: 'accept';
} | {
  kind: 'escalate';
};
type ReviewAuthorizer = (details: ReviewPermissionDetails, log: ReviewLog) => Promise<ReviewVerdict>;
//#endregion
//#region src/extension.d.ts
interface ReviewerFactoryOptions {
  config: AutoReviewConfig;
  registry: ModelRegistry;
  sessionManager: Pick<SessionManager, 'buildContextEntries'>;
  sessionSignal: AbortSignal;
}
interface AutoReviewExtensionDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  createReviewer?: (options: ReviewerFactoryOptions) => ReviewAuthorizer;
  reviewLog?: ReviewLog;
}
declare function createAutoReviewExtension(pi: ExtensionAPI, dependencies?: AutoReviewExtensionDependencies): void;
//#endregion
//#region src/index.d.ts
declare function permissionAutoReviewExtension(pi: ExtensionAPI): void;
//#endregion
export { type AutoReviewConfig, type AutoReviewExtensionDependencies, CONFIG_SCHEMA_URL, type ConfigIssue, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_TIMEOUT_MS, EXTENSION_ID, type LoadConfigOptions, type LoadConfigResult, autoReviewConfigSchema, buildAutoReviewJsonSchema, createAutoReviewExtension, permissionAutoReviewExtension as default, loadAutoReviewConfig };