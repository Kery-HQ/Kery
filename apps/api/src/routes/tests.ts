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
      "SELECT * FROM saved_tests WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId],
    );
    reply.send({ tests: rows });
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
    const sets: string[] = [];
    const values: any[] = [testId];
    let i = 2;
    if (body.name) { sets.push(`name = $${i++}`); values.push(body.name); }
    if (body.intent) { sets.push(`intent = $${i++}`); values.push(body.intent); }
    if (body.context !== undefined) { sets.push(`context = $${i++}`); values.push(body.context); }
    if (sets.length === 0) { reply.code(400).send({ error: "nothing to update" }); return; }
    const { rows } = await pool.query(`UPDATE saved_tests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
    reply.send({ test: rows[0] });
  });

  app.delete("/api/projects/:projectId/tests/:testId", async (req, reply) => {
    const { testId } = ProjectTestParams.parse(req.params);
    await pool.query("DELETE FROM saved_tests WHERE id = $1", [testId]);
    reply.send({ ok: true });
  });
}
