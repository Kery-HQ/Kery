export type EngineConfig = {
  openaiApiKey: string;
  openrouterApiKey: string;
  geminiApiKey: string;
  geminiAgentModel: string;
  geminiSummaryModel: string;
  geminiReviewModel: string;
  reviewAgentModel: string;
  geminiScriptModel: string;
  stagehandEnabled: boolean;
  stagehandModel: string;
  runTimeoutMinutes: number;
};

let _config: EngineConfig | null = null;

export function initEngineConfig(cfg: EngineConfig): void {
  _config = cfg;
}

export function getConfig(): EngineConfig {
  if (!_config) throw new Error("Engine config not initialized — call initEngineConfig() first");
  return _config;
}
