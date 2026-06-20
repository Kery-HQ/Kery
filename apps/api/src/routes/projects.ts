import { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditConnection, logger, type StorageAdapter } from "@kery/engine";
import { Pool } from "pg";
import { encryptConfigJson } from "@kery/db";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { RunJobData } from "../runQueue.js";
import { reconcileQueuedRunsForProject } from "../runQueueRecovery.js";
import {
  ProjectIdParams,
  ProjectEnvParams,
  ProjectMemoryEntryParams,
  ProjectUpdateBody,
} from "./params.js";

const RUN_LIST_FROM = `
  FROM test_runs tr
  LEFT JOIN saved_tests st ON st.id = tr.test_id
`;

const RUN_DISPLAY_NAME_SQL = `
  COALESCE(
    NULLIF(TRIM(tr.source_label), ''),
    st.name
  ) AS display_name
`;

const ProjectSchema = z.object({
  name: z.string().min(2),
  domain: z.string().optional().nullable(),
});

const EnvironmentSchema = z.object({
  name: z.string().min(2),
  baseUrl: z.string().url(),
  isDefault: z.boolean().optional(),
});

const EnvironmentUpdateSchema = z
  .object({
    name: z.string().min(2).optional(),
    baseUrl: z.string().url().optional(),
  })
  .refine((b) => b.name !== undefined || b.baseUrl !== undefined, {
    message: "at least one of name, baseUrl required",
  });

const AuthSchema = z.object({
  mode: z.enum(["ui", "apiToken", "oauthToken", "tokenProvider", "none"]),
  config: z.any().optional(),
});

const ConnectionTestSchema = z.object({
  baseUrl: z.string().optional(),
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

const ProjectRunsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.string().trim().max(40).optional(),
});

export function registerProjectRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  runQueue?: Queue<RunJobData>,
  redis?: Redis,
) {
  const pool = storage.getPool() as Pool;

  async function reconcileProjectQueue(projectId: string, reason: string): Promise<void> {
    if (!runQueue || !redis) return;
    await reconcileQueuedRunsForProject(storage, runQueue, redis, projectId, reason).catch((err) => {
      logger.warn({ projectId, reason, err: String(err) }, "Project queued run reconciliation failed");
    });
  }

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
    const body = ProjectUpdateBody.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) {
      sets.push(`name = $${i++}`);
      vals.push(body.name);
    }
    if (body.domain !== undefined) {
      sets.push(`domain = $${i++}`);
      vals.push(body.domain ? body.domain.trim() || null : null);
    }
    vals.push(projectId);
    const { rows } = await pool.query(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i++} RETURNING *`,
      vals,
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
    await reconcileProjectQueue(projectId, "project-overview");
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

  app.put("/api/projects/:projectId/environments/:environmentId", async (req, reply) => {
    const { projectId, environmentId } = ProjectEnvParams.parse(req.params);
    const parsed = EnvironmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.flatten() });
      return;
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (parsed.data.name !== undefined) {
      sets.push(`name = $${i++}`);
      vals.push(parsed.data.name);
    }
    if (parsed.data.baseUrl !== undefined) {
      sets.push(`base_url = $${i++}`);
      vals.push(parsed.data.baseUrl);
    }
    vals.push(environmentId, projectId);
    const { rows } = await pool.query(
      `UPDATE environments SET ${sets.join(", ")} WHERE id = $${i++} AND project_id = $${i++} RETURNING *`,
      vals,
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "environment not found" });
      return;
    }
    reply.send({ environment: rows[0] });
  });

  app.delete("/api/projects/:projectId/environments/:environmentId", async (req, reply) => {
    const { environmentId } = ProjectEnvParams.parse(req.params);
    await pool.query("DELETE FROM environments WHERE id = $1", [environmentId]);
    reply.send({ ok: true });
  });

  app.post("/api/projects/:projectId/environments/:environmentId/test-connection", async (req, reply) => {
    const { projectId, environmentId } = ProjectEnvParams.parse(req.params);
    const parsed = ConnectionTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload", details: parsed.error.flatten() });
      return;
    }
    const { rows: [env] } = await pool.query(
      "SELECT * FROM environments WHERE id = $1 AND project_id = $2",
      [environmentId, projectId],
    );
    if (!env) {
      reply.code(404).send({ error: "environment not found" });
      return;
    }

    const baseUrl = parsed.data.baseUrl?.trim() || env.base_url;
    const audit = await auditConnection(baseUrl);
    reply.send({ audit });
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
    const parsedQuery = ProjectRunsQuery.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      reply.code(400).send({ error: "invalid query", details: parsedQuery.error.issues });
      return;
    }

    const page = parsedQuery.data.page;
    const pageSize = parsedQuery.data.pageSize;
    const offset = (page - 1) * pageSize;
    const search = parsedQuery.data.search?.trim() || undefined;
    const status = parsedQuery.data.status?.trim() || undefined;
    const normalizedStatus = status && status !== "all" ? status : undefined;
    if (!normalizedStatus || normalizedStatus === "queued") {
      await reconcileProjectQueue(projectId, "project-runs-list");
    }

    const whereParts = ["tr.project_id = $1"];
    const params: unknown[] = [projectId];
    let n = 2;

    if (normalizedStatus) {
      whereParts.push(`tr.status = $${n++}`);
      params.push(normalizedStatus);
    }

    if (search) {
      whereParts.push(
        `(tr.id::text ILIKE $${n} OR COALESCE(NULLIF(TRIM(tr.source_label), ''), st.name, '') ILIKE $${n})`,
      );
      params.push(`%${search}%`);
      n += 1;
    }

    const whereSql = whereParts.join(" AND ");
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total ${RUN_LIST_FROM} WHERE ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const runParams = [...params, pageSize, offset];
    const limitParam = n++;
    const offsetParam = n++;
    const { rows } = await pool.query(
      `SELECT tr.*, ${RUN_DISPLAY_NAME_SQL} ${RUN_LIST_FROM}
       WHERE ${whereSql}
       ORDER BY tr.started_at DESC NULLS LAST
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      runParams,
    );
    reply.send({ runs: rows, page, pageSize, total });
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
}
