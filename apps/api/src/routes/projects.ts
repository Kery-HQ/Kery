import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StorageAdapter } from "@kery/engine";
import { Pool } from "pg";
import { encryptConfigJson } from "@kery/db";
import {
  ProjectIdParams,
  ProjectEnvParams,
  ProjectDestParams,
  ProjectDestMemoryEntryParams,
  ProjectMemoryEntryParams,
  ProjectUpdateBody,
} from "./params.js";

const ProjectSchema = z.object({
  name: z.string().min(2),
  domain: z.string().optional().nullable(),
});

const EnvironmentSchema = z.object({
  name: z.string().min(2),
  baseUrl: z.string().url(),
  isDefault: z.boolean().optional(),
});

const AuthSchema = z.object({
  mode: z.enum(["ui", "apiToken", "oauthToken", "tokenProvider", "none"]),
  config: z.any().optional(),
});

const MemoryEntryTypeEnum = z.enum(["learned_path", "ignore_region", "avoid_region", "bug_pattern", "tip"]);

const MemoryCreateBody = z.object({
  type: MemoryEntryTypeEnum,
  summary: z.string().min(1),
  content: z.string().min(1),
  region: z.object({ description: z.string() }).nullable().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

const MemoryPatchBody = z.object({
  type: MemoryEntryTypeEnum.optional(),
  summary: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  region: z.object({ description: z.string() }).nullable().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

async function assertDestinationInProject(
  storage: StorageAdapter,
  projectId: string,
  destinationId: string,
): Promise<boolean> {
  const dest = await storage.getDestination(destinationId);
  return !!(dest && String(dest.project_id) === projectId);
}

export function registerProjectRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = storage.getPool() as Pool;

  app.get("/api/projects", async (_req, reply) => {
    const { rows } = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
    reply.send({ projects: rows });
  });

  app.post("/api/projects", async (req, reply) => {
    const parsed = ProjectSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload", details: parsed.error.issues }); return; }
    const { rows } = await pool.query(
      "INSERT INTO projects (name, domain) VALUES ($1, $2) RETURNING *",
      [parsed.data.name, parsed.data.domain],
    );
    reply.send({ project: rows[0] });
  });

  app.put("/api/projects/:projectId", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { name } = ProjectUpdateBody.parse(req.body);
    const { rows } = await pool.query(
      "UPDATE projects SET name = $1 WHERE id = $2 RETURNING *",
      [name, projectId],
    );
    reply.send({ project: rows[0] });
  });

  app.delete("/api/projects/:projectId", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    reply.send({ ok: true });
  });

  // Overview
  app.get("/api/projects/:projectId/overview", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows: runs } = await pool.query(
      "SELECT status FROM test_runs WHERE project_id = $1", [projectId],
    );
    const total = runs.length;
    const passed = runs.filter(r => r.status === "passed").length;
    const failed = runs.filter(r => r.status === "failed").length;
    const running = runs.filter(r => r.status === "running").length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    // Prefer stored cost_usd; for older runs fall back to summing costUsd from llm_calls_json.
    const { rows: costRows } = await pool.query(
      `SELECT
        COALESCE((
          SELECT SUM(
            COALESCE(
              tr.cost_usd::numeric,
              (
                SELECT COALESCE(SUM((e->>'costUsd')::numeric), 0)
                FROM jsonb_array_elements(COALESCE(tr.llm_calls_json, '[]'::jsonb)) AS e
              )
            )
          )
          FROM test_runs tr
          WHERE tr.project_id = $1
        ), 0)
        + COALESCE((SELECT SUM(cost_usd) FROM crawl_runs WHERE project_id = $1), 0)
        AS total`,
      [projectId],
    );
    const totalCostUsd = Number(costRows[0]?.total ?? 0);
    reply.send({ totalRuns: total, passRate, passed, failed, running, totalCostUsd });
  });

  // Environments
  app.get("/api/projects/:projectId/environments", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows } = await pool.query("SELECT * FROM environments WHERE project_id = $1", [projectId]);
    reply.send({ environments: rows });
  });

  app.post("/api/projects/:projectId/environments", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const parsed = EnvironmentSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }
    const { rows } = await pool.query(
      "INSERT INTO environments (project_id, name, base_url, is_default) VALUES ($1, $2, $3, $4) RETURNING *",
      [projectId, parsed.data.name, parsed.data.baseUrl, parsed.data.isDefault ?? false],
    );
    reply.send({ environment: rows[0] });
  });

  app.delete("/api/projects/:projectId/environments/:environmentId", async (req, reply) => {
    const { environmentId } = ProjectEnvParams.parse(req.params);
    await pool.query("DELETE FROM environments WHERE id = $1", [environmentId]);
    reply.send({ ok: true });
  });

  // Auth config
  app.get("/api/projects/:projectId/environments/:environmentId/auth", async (req, reply) => {
    const { projectId, environmentId } = ProjectEnvParams.parse(req.params);
    const auth = await storage.getAuthConfig(projectId, environmentId);
    reply.send({ auth });
  });

  app.post("/api/projects/:projectId/environments/:environmentId/auth", async (req, reply) => {
    const { projectId, environmentId } = ProjectEnvParams.parse(req.params);
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }
    if (parsed.data.mode === "none") {
      await pool.query("DELETE FROM auth_configs WHERE project_id = $1 AND environment_id = $2", [projectId, environmentId]);
      reply.send({ auth: null });
      return;
    }
    const configToStore = encryptConfigJson(parsed.data.config ?? {});
    const { rows } = await pool.query(
      `INSERT INTO auth_configs (project_id, environment_id, mode, config_json) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, environment_id) DO UPDATE SET mode = $3, config_json = $4 RETURNING *`,
      [projectId, environmentId, parsed.data.mode, JSON.stringify(configToStore)],
    );
    reply.send({ auth: rows[0] });
  });

  // Runs list
  app.get("/api/projects/:projectId/runs", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows } = await pool.query(
      "SELECT * FROM test_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 100",
      [projectId],
    );
    reply.send({ runs: rows });
  });

  // Memory
  app.get("/api/projects/:projectId/memory", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const entries = await storage.loadProjectMemory(projectId);
    reply.send({ entries });
  });

  app.post("/api/projects/:projectId/memory", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const parsed = MemoryCreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.issues });
      return;
    }
    const { type, summary, content, region, confidence } = parsed.data;
    const regionJson = region != null ? JSON.stringify(region) : null;
    const { rows } = await pool.query(
      `INSERT INTO memory_entries (scope, project_id, type, summary, content, region, source, confidence)
       VALUES ('project', $1, $2, $3, $4, $5::jsonb, 'user', $6) RETURNING *`,
      [projectId, type, summary, content, regionJson, confidence ?? 50],
    );
    reply.send({ entry: rows[0] });
  });

  app.patch("/api/projects/:projectId/memory/:entryId", async (req, reply) => {
    const { projectId, entryId } = ProjectMemoryEntryParams.parse(req.params);
    const parsed = MemoryPatchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.issues });
      return;
    }
    const p = parsed.data;
    const parts: string[] = [];
    const vals: unknown[] = [];
    let n = 1;
    if (p.type !== undefined) {
      parts.push(`type = $${n++}`);
      vals.push(p.type);
    }
    if (p.summary !== undefined) {
      parts.push(`summary = $${n++}`);
      vals.push(p.summary);
    }
    if (p.content !== undefined) {
      parts.push(`content = $${n++}`);
      vals.push(p.content);
    }
    if (p.region !== undefined) {
      parts.push(`region = $${n++}::jsonb`);
      vals.push(p.region === null ? null : JSON.stringify(p.region));
    }
    if (p.confidence !== undefined) {
      parts.push(`confidence = $${n++}`);
      vals.push(p.confidence);
    }
    if (parts.length === 0) {
      reply.code(400).send({ error: "no fields to update" });
      return;
    }
    parts.push("updated_at = now()");
    vals.push(entryId, projectId);
    const { rows } = await pool.query(
      `UPDATE memory_entries SET ${parts.join(", ")}
       WHERE id = $${n++} AND scope = 'project' AND project_id = $${n++} RETURNING *`,
      vals,
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: "Memory entry not found" });
      return;
    }
    reply.send({ entry: rows[0] });
  });

  app.delete("/api/projects/:projectId/memory/:entryId", async (req, reply) => {
    const { projectId, entryId } = ProjectMemoryEntryParams.parse(req.params);
    const { rowCount } = await pool.query(
      `DELETE FROM memory_entries WHERE id = $1 AND scope = 'project' AND project_id = $2`,
      [entryId, projectId],
    );
    if (!rowCount) {
      reply.code(404).send({ error: "Memory entry not found" });
      return;
    }
    reply.send({ ok: true });
  });

  app.delete("/api/projects/:projectId/memory", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    await pool.query(`DELETE FROM memory_entries WHERE scope = 'project' AND project_id = $1`, [projectId]);
    reply.send({ ok: true });
  });

  // Coverage
  app.get("/api/projects/:projectId/coverage", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const coverage = await storage.getProjectCoverage(projectId);
    reply.send(coverage);
  });

  // Pages
  app.get("/api/projects/:projectId/pages", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows: destinations } = await pool.query(
      `SELECT id, normalized_route, title, health_status, issues_count, last_inspected_at, enabled, forms_json, interactions_json FROM app_tree_destinations WHERE project_id = $1 ORDER BY normalized_route`,
      [projectId],
    );
    const pages = destinations.map((d: any) => ({
      id: d.id, route: d.normalized_route, title: d.title,
      health: d.health_status, issues: d.issues_count, enabled: d.enabled,
      formCount: (d.forms_json || []).length, interactionCount: (d.interactions_json || []).length,
    }));
    const coverage = await storage.getProjectCoverage(projectId);
    const { rows: lastScanRows } = await pool.query(
      `SELECT id, status, pages_visited, nodes_found, started_at, completed_at, cost_usd,
              llm_cost_breakdown_json, crawl_metadata_json
       FROM crawl_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId],
    );
    reply.send({ pages, coverage, lastScan: lastScanRows[0] ?? null });
  });

  // Page-scoped memory (must be registered before GET .../pages/:destinationId)
  app.get("/api/projects/:projectId/pages/:destinationId/memory", async (req, reply) => {
    const { projectId, destinationId } = ProjectDestParams.parse(req.params);
    if (!(await assertDestinationInProject(storage, projectId, destinationId))) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    const entries = await storage.loadPageMemory(destinationId);
    reply.send({ entries });
  });

  app.post("/api/projects/:projectId/pages/:destinationId/memory", async (req, reply) => {
    const { projectId, destinationId } = ProjectDestParams.parse(req.params);
    const parsed = MemoryCreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.issues });
      return;
    }
    if (!(await assertDestinationInProject(storage, projectId, destinationId))) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    const { type, summary, content, region, confidence } = parsed.data;
    const regionJson = region != null ? JSON.stringify(region) : null;
    const { rows } = await pool.query(
      `INSERT INTO memory_entries (scope, destination_id, type, summary, content, region, source, confidence)
       VALUES ('page', $1, $2, $3, $4, $5::jsonb, 'user', $6) RETURNING *`,
      [destinationId, type, summary, content, regionJson, confidence ?? 50],
    );
    reply.send({ entry: rows[0] });
  });

  app.patch("/api/projects/:projectId/pages/:destinationId/memory/:entryId", async (req, reply) => {
    const { projectId, destinationId, entryId } = ProjectDestMemoryEntryParams.parse(req.params);
    const parsed = MemoryPatchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.issues });
      return;
    }
    if (!(await assertDestinationInProject(storage, projectId, destinationId))) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    const p = parsed.data;
    const parts: string[] = [];
    const vals: unknown[] = [];
    let n = 1;
    if (p.type !== undefined) {
      parts.push(`type = $${n++}`);
      vals.push(p.type);
    }
    if (p.summary !== undefined) {
      parts.push(`summary = $${n++}`);
      vals.push(p.summary);
    }
    if (p.content !== undefined) {
      parts.push(`content = $${n++}`);
      vals.push(p.content);
    }
    if (p.region !== undefined) {
      parts.push(`region = $${n++}::jsonb`);
      vals.push(p.region === null ? null : JSON.stringify(p.region));
    }
    if (p.confidence !== undefined) {
      parts.push(`confidence = $${n++}`);
      vals.push(p.confidence);
    }
    if (parts.length === 0) {
      reply.code(400).send({ error: "no fields to update" });
      return;
    }
    parts.push("updated_at = now()");
    vals.push(entryId, destinationId);
    const { rows } = await pool.query(
      `UPDATE memory_entries SET ${parts.join(", ")}
       WHERE id = $${n++} AND scope = 'page' AND destination_id = $${n++} RETURNING *`,
      vals,
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: "Memory entry not found" });
      return;
    }
    reply.send({ entry: rows[0] });
  });

  app.delete("/api/projects/:projectId/pages/:destinationId/memory/:entryId", async (req, reply) => {
    const { projectId, destinationId, entryId } = ProjectDestMemoryEntryParams.parse(req.params);
    if (!(await assertDestinationInProject(storage, projectId, destinationId))) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    const { rowCount } = await pool.query(
      `DELETE FROM memory_entries WHERE id = $1 AND scope = 'page' AND destination_id = $2`,
      [entryId, destinationId],
    );
    if (!rowCount) {
      reply.code(404).send({ error: "Memory entry not found" });
      return;
    }
    reply.send({ ok: true });
  });

  app.delete("/api/projects/:projectId/pages/:destinationId/memory", async (req, reply) => {
    const { projectId, destinationId } = ProjectDestParams.parse(req.params);
    if (!(await assertDestinationInProject(storage, projectId, destinationId))) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    await pool.query(`DELETE FROM memory_entries WHERE scope = 'page' AND destination_id = $1`, [destinationId]);
    reply.send({ ok: true });
  });

  app.get("/api/projects/:projectId/pages/:destinationId", async (req, reply) => {
    const { projectId, destinationId } = ProjectDestParams.parse(req.params);
    const dest = await storage.getDestination(destinationId);
    if (!dest || String(dest.project_id) !== projectId) {
      reply.code(404).send({ error: "Page not found" });
      return;
    }
    reply.send({ page: dest, recentRuns: [] });
  });
}
