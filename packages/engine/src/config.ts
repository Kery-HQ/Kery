/** Keys for per-role model + optional custom $/1M token pricing (USD). */
export const MODEL_CONFIG_KEYS = [
  "agentModel",
  "crawlModel",
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
  /** Crawl, path plans, auxiliary text: link filtering, suggested flows, intents, destination test plans. */
  crawlModel: string;
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

export function initEngineConfig(cfg: EngineConfig): void {
  _config = cfg;
}

export function getConfig(): EngineConfig {
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  return _config;
}

/** Merge partial overrides into the running config (e.g. from DB settings). */
export function updateEngineConfig(overrides: Partial<EngineConfig>): void {
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  _config = { ..._config, ...overrides };
}
