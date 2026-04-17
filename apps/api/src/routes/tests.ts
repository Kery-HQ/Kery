import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { ProjectIdParams, ProjectTestParams, TestUpdateBody } from "./params.js";

const TestSchema = z.object({
  name: z.string().min(2),
  intent: z.string().min(3),
  context: z.string().optional(),
});

export function registerTestRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = storage.getPool() as Pool;

  app.get("/api/projects/:projectId/tests", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows } = await pool.query(
      `SELECT st.*,
              COUNT(DISTINCT b.id) FILTER (WHERE b.status NOT IN ('resolved', 'wont_fix')) AS issues_count
       FROM saved_tests st
       LEFT JOIN test_runs tr ON tr.test_id = st.id
       LEFT JOIN bugs b ON b.run_id = tr.id
       WHERE st.project_id = $1
       GROUP BY st.id
       ORDER BY st.created_at DESC`,
      [projectId],
    );
    reply.send({ tests: rows.map(r => ({ ...r, issues_count: Number(r.issues_count) })) });
  });

  app.post("/api/projects/:projectId/tests", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const parsed = TestSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }
    const { rows } = await pool.query(
      "INSERT INTO saved_tests (project_id, name, intent, context, save_screenshots) VALUES ($1, $2, $3, $4, true) RETURNING *",
      [projectId, parsed.data.name, parsed.data.intent, parsed.data.context ?? null],
    );
    reply.send({ test: rows[0] });
  });

  app.put("/api/projects/:projectId/tests/:testId", async (req, reply) => {
    const { testId } = ProjectTestParams.parse(req.params);
    const body = TestUpdateBody.parse(req.body);
    const { rows: curRows } = await pool.query("SELECT * FROM saved_tests WHERE id = $1", [testId]);
    if (curRows.length === 0) { reply.code(404).send({ error: "not found" }); return; }
    const cur = curRows[0];

    const hasPatch =
      body.name !== undefined ||
      body.intent !== undefined ||
      body.context !== undefined ||
      body.reset_script === true;
    if (!hasPatch) { reply.code(400).send({ error: "nothing to update" }); return; }

    const name = body.name ?? cur.name;
    const intent = body.intent ?? cur.intent;
    const context = body.context !== undefined ? body.context : cur.context;

    const intentChanged =
      body.intent !== undefined &&
      String(body.intent).trim() !== String(cur.intent ?? "").trim();

    let regression_plan = cur.regression_plan;
    let plan_status = cur.plan_status;
    let plan_success_count = cur.plan_success_count;
    if (body.reset_script === true || intentChanged) {
      regression_plan = null;
      plan_status = "none";
      plan_success_count = 0;
    }

    const { rows } = await pool.query(
      `UPDATE saved_tests SET name = $2, intent = $3, context = $4, regression_plan = $5, plan_status = $6, plan_success_count = $7 WHERE id = $1 RETURNING *`,
      [testId, name, intent, context, regression_plan, plan_status, plan_success_count],
    );
    reply.send({ test: rows[0] });
  });

  app.patch("/api/projects/:projectId/tests/:testId", async (req, reply) => {
    const { testId } = ProjectTestParams.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const { rows } = await pool.query(
      `UPDATE saved_tests SET enabled = $2 WHERE id = $1 RETURNING *`,
      [testId, body.enabled],
    );
    if (rows.length === 0) { reply.code(404).send({ error: "not found" }); return; }
    reply.send({ test: rows[0] });
  });

  app.patch("/api/projects/:projectId/tests/:testId", async (req, reply) => {
    const { testId } = ProjectTestParams.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const { rows } = await pool.query(
      `UPDATE saved_tests SET enabled = $2 WHERE id = $1 RETURNING *`,
      [testId, body.enabled],
    );
    if (rows.length === 0) { reply.code(404).send({ error: "not found" }); return; }
    reply.send({ test: rows[0] });
  });

  app.delete("/api/projects/:projectId/tests/:testId", async (req, reply) => {
    const { testId } = ProjectTestParams.parse(req.params);
    await pool.query("DELETE FROM saved_tests WHERE id = $1", [testId]);
    reply.send({ ok: true });
  });
}
