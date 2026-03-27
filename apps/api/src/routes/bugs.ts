import { FastifyInstance } from "fastify";
import type { StorageAdapter } from "@kery/engine";
import { Pool } from "pg";

export function registerBugRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = (storage as any).pool as Pool;

  app.get("/api/projects/:projectId/bugs", async (req, reply) => {
    const { projectId } = req.params as any;
    const bugs = await storage.listBugs(projectId);
    reply.send({ bugs });
  });

  app.get("/api/bugs/:bugId/screenshot", async (req, reply) => {
    const { bugId } = req.params as any;
    const screenshot = await storage.getBugScreenshot(bugId);
    if (!screenshot) { reply.code(404).send({ error: "screenshot not found" }); return; }
    reply.send({ screenshot });
  });

  app.patch("/api/projects/:projectId/bugs/:bugId", async (req, reply) => {
    const { bugId } = req.params as any;
    const body = req.body as any;
    if (body.status) {
      await pool.query("UPDATE bugs SET status = $1 WHERE id = $2", [body.status, bugId]);
    }
    reply.send({ ok: true });
  });
}
