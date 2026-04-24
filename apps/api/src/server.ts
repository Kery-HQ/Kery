import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initEngineConfig, updateEngineConfig } from "@kery/engine";
import { initPool } from "@kery/db";
import { PostgresAdapter } from "@kery/db";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerCrawlRoutes } from "./routes/crawl.js";
import { registerTestRoutes } from "./routes/tests.js";
import { registerBugRoutes } from "./routes/bugs.js";
import { registerSettingsRoutes, applyDbModelSettings } from "./routes/settings.js";
import { Redis } from "ioredis";
import { createRunQueue } from "./runQueue.js";
import { withRunCorrelation } from "@kery/engine";

// Initialize engine config from environment
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

// Initialize database
const pool = initPool(config.databaseUrl);
const storage = new PostgresAdapter(pool);

// Initialize BullMQ queue (enqueue only — execution handled by the worker process)
const { queue: runQueue } = createRunQueue(config.redisUrl);
/** Redis client for live snapshot reads and run stop signals. */
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: [config.appUrl, "http://localhost:19834", "http://localhost:3000", "http://localhost:5173"],
  credentials: true,
});

// Per-request correlation ID: extract runId from URL params for run-scoped logging
app.addHook("onRequest", (request, _reply, done) => {
  const runIdMatch = request.url.match(/\/runs\/([a-f0-9-]+)/);
  if (runIdMatch) {
    (request as any).runCorrelationId = runIdMatch[1];
  }
  done();
});

// Apply any model overrides saved in the DB
await applyDbModelSettings(storage);

// Mark zombie runs (stuck in "running" from a previous crash) as failed
await pool.query(
  `UPDATE test_runs SET status = 'failed', summary = 'Interrupted — server restarted', completed_at = now() WHERE status = 'running'`,
).then(({ rowCount }) => {
  if (rowCount && rowCount > 0) console.log(`Recovered ${rowCount} zombie run(s) from previous crash`);
}).catch(() => {});

// Health check
app.get("/health", async () => ({ status: "ok" }));

// Register routes — pass storage adapter and run queue
registerProjectRoutes(app, storage);
registerRunRoutes(app, storage, runQueue, redis, config.redisUrl);
registerCrawlRoutes(app, storage);
registerTestRoutes(app, storage);
registerBugRoutes(app, storage);
registerSettingsRoutes(app, storage);

// Start server
try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Kery API listening on port ${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down gracefully...");
  await runQueue.close();
  await app.close();
  await pool.end();
  await redis.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
