import dotenv from "dotenv";
import path from "path";
dotenv.config();
if (process.env.INIT_CWD && process.env.INIT_CWD !== process.cwd()) {
  dotenv.config({ path: path.resolve(process.env.INIT_CWD, ".env") });
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgresql://kery:kery@localhost:11112/kery",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  customLlmBaseUrl: process.env.CUSTOM_LLM_BASE_URL || "",
  customLlmApiKey: process.env.CUSTOM_LLM_API_KEY || "",
  agentModel: process.env.AGENT_MODEL || "anthropic/claude-sonnet-5",
  auxiliaryModel:
    process.env.AUXILIARY_MODEL ||
    process.env.CRAWL_MODEL ||
    process.env.SCRIPT_MODEL ||
    process.env.SUMMARY_MODEL ||
    process.env.REVIEW_MODEL ||
    "anthropic/claude-haiku-4.5",
  reviewAgentModel: process.env.REVIEW_AGENT_MODEL || "anthropic/claude-sonnet-5",
  stagehandEnabled: process.env.STAGEHAND_ENABLED !== "false",
  stagehandModel: process.env.STAGEHAND_MODEL || "anthropic/claude-haiku-4.5",
  runTimeoutMinutes: Number(process.env.RUN_TIMEOUT_MINUTES || 15),
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
  reviewTimeoutMs: Number(process.env.REVIEW_TIMEOUT_MS || 30000),
};
