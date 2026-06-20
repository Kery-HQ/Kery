import { config } from "./config.js";
import { initEngineConfig, updateEngineConfig } from "@kery/engine";
import { initPool, PostgresAdapter, decryptValue } from "@kery/db";
import { Redis } from "ioredis";
import { createRunQueue, createRunWorker } from "./runQueue.js";

initEngineConfig({
  openaiApiKey: config.openaiApiKey,
  openrouterApiKey: config.openrouterApiKey,
  anthropicApiKey: config.anthropicApiKey,
  geminiApiKey: config.geminiApiKey,
  agentModel: config.agentModel,
  auxiliaryModel: config.auxiliaryModel,
  reviewAgentModel: config.reviewAgentModel,
  stagehandEnabled: config.stagehandEnabled,
  stagehandModel: config.stagehandModel,
  runTimeoutMinutes: config.runTimeoutMinutes,
  llmTimeoutMs: config.llmTimeoutMs,
  reviewTimeoutMs: config.reviewTimeoutMs,
  modelPriceUsdPerMillion: {},
});

const pool = initPool(config.databaseUrl);
const storage = new PostgresAdapter(pool);

// Apply DB-persisted API key overrides (DB wins over .env) and model overrides
try {
  const all = await storage.getSettings();
  const keyOverrides: Record<string, string> = {};
  const keyMap: Record<string, string> = {
    "apiKey.openai": "openaiApiKey",
    "apiKey.anthropic": "anthropicApiKey",
    "apiKey.gemini": "geminiApiKey",
    "apiKey.openrouter": "openrouterApiKey",
  };
  for (const [dbKey, cfgKey] of Object.entries(keyMap)) {
    if (all[dbKey]) keyOverrides[cfgKey] = decryptValue(all[dbKey]);
  }
  const modelOverrides: Record<string, string> = {};
  const modelMap: Record<string, string> = {
    "model.agentModel": "agentModel",
    "model.reviewAgentModel": "reviewAgentModel",
    "model.stagehandModel": "stagehandModel",
  };
  for (const [dbKey, cfgKey] of Object.entries(modelMap)) {
    if (all[dbKey]) modelOverrides[cfgKey] = all[dbKey];
  }
  const auxiliaryModel =
    all["model.auxiliaryModel"] ??
    all["model.scriptModel"] ??
    all["model.summaryModel"] ??
    all["model.reviewModel"];
  if (auxiliaryModel) modelOverrides.auxiliaryModel = auxiliaryModel;

  if (Object.keys(keyOverrides).length > 0 || Object.keys(modelOverrides).length > 0) {
    updateEngineConfig({ ...keyOverrides, ...modelOverrides });
  }
} catch {
  // settings table may not exist yet — skip silently
}

const { queue: runQueue, connection: redisConnection } = createRunQueue(config.redisUrl);

/** Shared Redis client for run stop signals (API sets key, worker polls). */
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Dedicated Redis client for pub/sub publishing (cannot share with commands client). */
const redisPub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const runWorker = await createRunWorker(redisConnection, storage, redis, redisPub, runQueue);

console.log("Kery worker started — waiting for jobs");

async function shutdown() {
  console.log("Worker shutting down gracefully...");
  await runWorker.close();
  await runQueue.close();
  await pool.end();
  await redis.quit().catch(() => {});
  await redisPub.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
