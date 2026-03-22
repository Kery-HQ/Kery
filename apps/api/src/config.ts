import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8080),
  appUrl: process.env.APP_URL || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL || "postgresql://kery:kery@localhost:5432/kery",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiAgentModel: process.env.GEMINI_AGENT_MODEL || "openai/gpt-4o-mini",
  geminiSummaryModel: process.env.GEMINI_SUMMARY_MODEL || "gemini-2.5-flash-lite",
  geminiReviewModel: process.env.GEMINI_REVIEW_MODEL || "gemini-2.5-flash-lite",
  reviewAgentModel: process.env.REVIEW_AGENT_MODEL || "anthropic/claude-sonnet-4.6",
  geminiScriptModel: process.env.GEMINI_SCRIPT_MODEL || "gemini-2.5-flash",
  stagehandEnabled: process.env.STAGEHAND_ENABLED !== "false",
  stagehandModel: process.env.STAGEHAND_MODEL || "google/gemini-2.0-flash",
  runTimeoutMinutes: Number(process.env.RUN_TIMEOUT_MINUTES || 15),
};
