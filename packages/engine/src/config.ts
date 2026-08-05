import { AsyncLocalStorage } from "node:async_hooks";
/** Keys for per-role model + optional custom $/1M token pricing (USD). */
export const MODEL_CONFIG_KEYS = [
  "agentModel",
  "auxiliaryModel",
  "reviewAgentModel",
  "stagehandModel",
] as const;
export type ModelConfigKey = (typeof MODEL_CONFIG_KEYS)[number];

export type EngineConfig = {
  openaiApiKey: string;
  openrouterApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  agentModel: string;
  /** Text/JSON auxiliary work: crawl, path plans, memory curation, intents, summarization — not the main browser agent. */
  auxiliaryModel: string;
  reviewAgentModel: string;
  stagehandEnabled: boolean;
  stagehandModel: string;
  runTimeoutMinutes: number;
  llmTimeoutMs: number;
  reviewTimeoutMs: number;
  /** When set for a role, cost estimates use these $/1M token rates instead of the built-in table. */
  modelPriceUsdPerMillion?: Partial<Record<ModelConfigKey, { input: number; output: number }>>;
};

let _config: EngineConfig | null = null;

/**
 * Per-run config overlay. Workers process several runs concurrently in one
 * process, so a run that wants different models (A/B model experiments,
 * per-project overrides) cannot mutate the shared singleton. AsyncLocalStorage
 * scopes the override to one job's async tree instead.
 */
const runScope = new AsyncLocalStorage<EngineConfig>();

export function initEngineConfig(cfg: EngineConfig): void {
  _config = cfg;
}

export function getConfig(): EngineConfig {
  const scoped = runScope.getStore();
  if (scoped) return scoped;
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  return _config;
}

/** Run `fn` with `overrides` merged over the current config, for this async tree only. */
export function withEngineConfig<T>(overrides: Partial<EngineConfig>, fn: () => Promise<T>): Promise<T> {
  if (Object.keys(overrides).length === 0) return fn();
  return runScope.run({ ...getConfig(), ...overrides }, fn);
}

/** Merge partial overrides into the running config (e.g. from DB settings). */
export function updateEngineConfig(overrides: Partial<EngineConfig>): void {
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  _config = { ..._config, ...overrides };
}
