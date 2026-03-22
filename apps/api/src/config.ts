import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 19833),
  appUrl: process.env.APP_URL || "http://localhost:19834",
  databaseUrl: process.env.DATABASE_URL || "postgresql://kery:kery@localhost:19832/kery",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  agentModel: process.env.AGENT_MODEL || "openai/gpt-4.1-mini",
  summaryModel: process.env.SUMMARY_MODEL || "gemini-2.5-flash-lite",
  reviewModel: process.env.REVIEW_MODEL || "gemini-2.5-flash-lite",
  reviewAgentModel: process.env.REVIEW_AGENT_MODEL || "anthropic/claude-sonnet-4.6",
  scriptModel: process.env.SCRIPT_MODEL || "gemini-2.5-flash",
  stagehandEnabled: process.env.STAGEHAND_ENABLED !== "false",
  stagehandModel: process.env.STAGEHAND_MODEL || "google/gemini-2.0-flash",
  runTimeoutMinutes: Number(process.env.RUN_TIMEOUT_MINUTES || 15),
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
  reviewTimeoutMs: Number(process.env.REVIEW_TIMEOUT_MS || 30000),
};
