import { FastifyInstance } from "fastify";
import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { executeCrawlRun, logger } from "@kery/engine";
import { ProjectIdParams, ProjectCrawlRunParams } from "./params.js";

export function registerCrawlRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = storage.getPool() as Pool;

  app.post("/api/projects/:projectId/crawl", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows: envs } = await pool.query(
      "SELECT id FROM environments WHERE project_id = $1 AND allow_crawl = true LIMIT 1",
      [projectId],
    );
    const environmentId = envs[0]?.id;
    if (!environmentId) { reply.code(400).send({ error: "No crawlable environment configured." }); return; }

    reply.send({ status: "started", message: "Crawl started" });

    (async () => {
      try {
        const { result } = await executeCrawlRun(storage, projectId, environmentId, "manual");
        logger.info({ projectId, destinations: result.destinationsBuilt }, "Crawl complete");
      } catch (err) {
        logger.error({ err: String(err), projectId }, "Background crawl failed");
      }
    })();
  });

  app.post("/api/projects/:projectId/scan", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows: envs } = await pool.query(
      "SELECT id FROM environments WHERE project_id = $1 LIMIT 1",
      [projectId],
    );
    const environmentId = envs[0]?.id;
    if (!environmentId) { reply.code(400).send({ error: "Add an environment first." }); return; }

    reply.send({ status: "scanning", message: "Scanning your app..." });

    (async () => {
      try {
        const { result } = await executeCrawlRun(storage, projectId, environmentId, "manual");
        logger.info({ projectId, pages: result.destinationsBuilt }, "Scan complete");
      } catch (err) {
        logger.error({ err: String(err), projectId }, "Scan failed");
      }
    })();
  });

  app.get("/api/projects/:projectId/scan/status", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
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
      `SELECT id, project_id, environment_id, status, trigger_type, pages_visited, nodes_found, destinations_built,
              started_at, completed_at, cost_usd, llm_cost_breakdown_json
       FROM crawl_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20`,
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
