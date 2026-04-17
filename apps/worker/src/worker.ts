import { config } from "./config.js";
import { initEngineConfig, updateEngineConfig } from "@kery/engine";
import { initPool } from "@kery/db";
import { PostgresAdapter } from "@kery/db";
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

const { connection: redisConnection } = createRunQueue(config.redisUrl);

/** Shared Redis client for run stop signals (API sets key, worker polls). */
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Dedicated Redis client for pub/sub publishing (cannot share with commands client). */
const redisPub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const runWorker = createRunWorker(redisConnection, storage, redis, redisPub);

console.log("Kery worker started — waiting for jobs");

async function shutdown() {
  console.log("Worker shutting down gracefully...");
  await runWorker.close();
  await pool.end();
  await redis.quit().catch(() => {});
  await redisPub.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
