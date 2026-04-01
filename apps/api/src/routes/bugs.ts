import { FastifyInstance } from "fastify";
import type { StorageAdapter } from "@kery/engine";
import { Pool } from "pg";
import { ProjectIdParams, BugIdParams, ProjectBugParams, BugPatchBody } from "./params.js";

export function registerBugRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = storage.getPool() as Pool;

  app.get("/api/projects/:projectId/bugs", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const bugs = await storage.listBugs(projectId);
    reply.send({ bugs });
  });

  app.get("/api/bugs/:bugId/screenshot", async (req, reply) => {
    const { bugId } = BugIdParams.parse(req.params);
    const screenshot = await storage.getBugScreenshot(bugId);
    if (!screenshot) { reply.code(404).send({ error: "screenshot not found" }); return; }
    reply.send({ screenshot });
  });

  app.patch("/api/projects/:projectId/bugs/:bugId", async (req, reply) => {
    const { projectId, bugId } = ProjectBugParams.parse(req.params);
    const { status } = BugPatchBody.parse(req.body);
    const { rowCount } = await pool.query(
      "UPDATE bugs SET status = $1 WHERE id = $2 AND project_id = $3",
      [status, bugId, projectId],
    );
    if (rowCount === 0) {
      reply.code(404).send({ error: "bug not found" });
      return;
    }
    reply.send({ ok: true });
  });
}
