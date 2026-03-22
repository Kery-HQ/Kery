export type EngineConfig = {
  openaiApiKey: string;
  openrouterApiKey: string;
  geminiApiKey: string;
  agentModel: string;
  summaryModel: string;
  reviewModel: string;
  reviewAgentModel: string;
  scriptModel: string;
  stagehandEnabled: boolean;
  stagehandModel: string;
  runTimeoutMinutes: number;
  llmTimeoutMs: number;
  reviewTimeoutMs: number;
};

let _config: EngineConfig | null = null;

export function initEngineConfig(cfg: EngineConfig): void {
  _config = cfg;
}

export function getConfig(): EngineConfig {
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  return _config;
}
