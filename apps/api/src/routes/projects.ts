import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StorageAdapter } from "@kery/engine";
import { Pool } from "pg";
import { encryptConfigJson } from "@kery/db";
import { ProjectIdParams, ProjectEnvParams, ProjectDestParams, ProjectUpdateBody } from "./params.js";

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

export function registerProjectRoutes(app: FastifyInstance, storage: StorageAdapter) {
  // We need the raw pool for direct queries not in the StorageAdapter
  const pool = (storage as any).pool as Pool;

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
    reply.send({ totalRuns: total, passRate, passed, failed, running });
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
    reply.send({ pages, coverage });
  });

  app.get("/api/projects/:projectId/pages/:destinationId", async (req, reply) => {
    const { destinationId } = ProjectDestParams.parse(req.params);
    const dest = await storage.getDestination(destinationId);
    if (!dest) { reply.code(404).send({ error: "Page not found" }); return; }
    reply.send({ page: dest, recentRuns: [] });
  });
}
