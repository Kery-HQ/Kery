import { FastifyInstance } from "fastify";
import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { logger } from "@kery/engine";
import type { Queue } from "bullmq";
import type { CrawlJobData } from "../runQueue.js";
import { ProjectIdParams, ProjectCrawlRunParams } from "./params.js";

/** Runs left as `running` after crash / killed process are auto-failed so the UI can scan again. */
const STALE_RUNNING_MINUTES = 3 * 60; // 3 hours

async function expireStaleRunningCrawls(pool: Pool, projectId: string): Promise<void> {
  await pool.query(
    `UPDATE crawl_runs SET status = 'failed', completed_at = NOW()
     WHERE project_id = $1 AND status = 'running'
       AND started_at < NOW() - ($2::int * INTERVAL '1 minute')`,
    [projectId, STALE_RUNNING_MINUTES],
  );
}

async function abortAllRunningCrawls(pool: Pool, projectId: string): Promise<void> {
  await pool.query(
    `UPDATE crawl_runs SET status = 'failed', completed_at = NOW()
     WHERE project_id = $1 AND status = 'running'`,
    [projectId],
  );
}

async function hasRunningCrawl(pool: Pool, projectId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM crawl_runs WHERE project_id = $1 AND status = 'running' LIMIT 1`,
    [projectId],
  );
  return !!rows[0];
}

export function registerCrawlRoutes(app: FastifyInstance, storage: StorageAdapter, crawlQueue: Queue<CrawlJobData>) {
  const pool = storage.getPool() as Pool;

  app.post("/api/projects/:projectId/crawl", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const force = String((req.query as { force?: string }).force) === "true";

    await expireStaleRunningCrawls(pool, projectId);
    if (await hasRunningCrawl(pool, projectId)) {
      if (force) await abortAllRunningCrawls(pool, projectId);
      else {
        reply.code(409).send({
          error: "scan_in_progress",
          message: "A crawl is already running. Pass ?force=true to replace it.",
        });
        return;
      }
    }

    const { rows: envs } = await pool.query(
      "SELECT id FROM environments WHERE project_id = $1 AND allow_crawl = true LIMIT 1",
      [projectId],
    );
    const environmentId = envs[0]?.id;
    if (!environmentId) { reply.code(400).send({ error: "No crawlable environment configured." }); return; }

    await crawlQueue.add("crawl", { projectId, environmentId, triggerType: "manual" } satisfies CrawlJobData);
    logger.info({ projectId, environmentId }, "Crawl job enqueued");

    reply.send({ status: "started", message: "Crawl started" });
  });

  app.post("/api/projects/:projectId/scan", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const force = String((req.query as { force?: string }).force) === "true";

    await expireStaleRunningCrawls(pool, projectId);

    if (await hasRunningCrawl(pool, projectId)) {
      if (force) {
        await abortAllRunningCrawls(pool, projectId);
      } else {
        reply.code(409).send({
          error: "scan_in_progress",
          message: "A scan is already running. Wait for it to finish, or pass ?force=true to replace it.",
        });
        return;
      }
    }

    const { rows: envs } = await pool.query(
      "SELECT id FROM environments WHERE project_id = $1 LIMIT 1",
      [projectId],
    );
    const environmentId = envs[0]?.id;
    if (!environmentId) { reply.code(400).send({ error: "Add an environment first." }); return; }

    await crawlQueue.add("crawl", { projectId, environmentId, triggerType: "manual" } satisfies CrawlJobData);
    logger.info({ projectId, environmentId }, "Scan job enqueued");

    reply.send({ status: "scanning", message: "Scanning your app..." });
  });

  app.get("/api/projects/:projectId/scan/status", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    await expireStaleRunningCrawls(pool, projectId);
    const { rows } = await pool.query(
      `SELECT id, status, pages_visited, nodes_found, started_at, completed_at, cost_usd,
              llm_cost_breakdown_json, crawl_metadata_json
       FROM crawl_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId],
    );
    reply.send({ scan: rows[0] || null });
  });

  app.get("/api/projects/:projectId/crawl/runs", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT id, status, pages_visited, started_at, completed_at, cost_usd, llm_cost_breakdown_json
       FROM crawl_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 5`,
      [projectId],
    );
    reply.send({ runs: rows });
  });

  app.get("/api/projects/:projectId/crawl/runs/:crawlRunId", async (req, reply) => {
    const { projectId, crawlRunId } = ProjectCrawlRunParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT * FROM crawl_runs WHERE id = $1 AND project_id = $2`,
      [crawlRunId, projectId],
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "Crawl run not found" });
      return;
    }
    reply.send({ run: rows[0] });
  });
}
