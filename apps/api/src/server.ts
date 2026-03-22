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

// Initialize engine config from environment
initEngineConfig({
  openaiApiKey: config.openaiApiKey,
  openrouterApiKey: config.openrouterApiKey,
  geminiApiKey: config.geminiApiKey,
  agentModel: config.agentModel,
  summaryModel: config.summaryModel,
  reviewModel: config.reviewModel,
  reviewAgentModel: config.reviewAgentModel,
  scriptModel: config.scriptModel,
  stagehandEnabled: config.stagehandEnabled,
  stagehandModel: config.stagehandModel,
  runTimeoutMinutes: config.runTimeoutMinutes,
  llmTimeoutMs: config.llmTimeoutMs,
  reviewTimeoutMs: config.reviewTimeoutMs,
});

// Initialize database
const pool = initPool(config.databaseUrl);
const storage = new PostgresAdapter(pool);

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: [config.appUrl, "http://localhost:19834", "http://localhost:3000"],
  credentials: true,
});

// Apply any model overrides saved in the DB
await applyDbModelSettings(storage);

// Health check
app.get("/health", async () => ({ status: "ok" }));

// Register routes — pass storage adapter
registerProjectRoutes(app, storage);
registerRunRoutes(app, storage);
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
