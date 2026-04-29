import fs from "fs";
import path from "path";
import { FastifyInstance } from "fastify";
import type { StorageAdapter } from "@kery/engine";
import { Pool } from "pg";
import {
  ProjectIdParams,
  BugIdParams,
  ProjectBugParams,
  BugPatchBody,
  BugBulkDeleteBody,
} from "./params.js";

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");

function unlinkBugScreenshotFile(runId: string, screenshotPath: string | null) {
  if (!screenshotPath) return;
  const basename = path.basename(screenshotPath);
  // New location (independent of run)
  try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, "bugs", basename)); } catch { /* missing is fine */ }
  // Old location (backward compat — screenshots not yet migrated)
  try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, runId, basename)); } catch { /* missing is fine */ }
}

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

  app.delete("/api/projects/:projectId/bugs/:bugId", async (req, reply) => {
    const { projectId, bugId } = ProjectBugParams.parse(req.params);
    const { rows } = await pool.query<{ run_id: string; screenshot_path: string | null }>(
      "SELECT run_id, screenshot_path FROM bugs WHERE id = $1 AND project_id = $2",
      [bugId, projectId],
    );
    if (rows.length === 0) {
      reply.code(404).send({ error: "bug not found" });
      return;
    }
    unlinkBugScreenshotFile(rows[0].run_id, rows[0].screenshot_path);
    await pool.query("DELETE FROM bugs WHERE id = $1 AND project_id = $2", [bugId, projectId]);
    reply.send({ ok: true, deleted: 1 });
  });

  app.post("/api/projects/:projectId/bugs/bulk-delete", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { ids } = BugBulkDeleteBody.parse(req.body);
    const { rows } = await pool.query<{ id: string; run_id: string; screenshot_path: string | null }>(
      "SELECT id, run_id, screenshot_path FROM bugs WHERE project_id = $1 AND id = ANY($2::uuid[])",
      [projectId, ids],
    );
    for (const r of rows) {
      unlinkBugScreenshotFile(r.run_id, r.screenshot_path);
    }
    const { rowCount } = await pool.query(
      "DELETE FROM bugs WHERE project_id = $1 AND id = ANY($2::uuid[])",
      [projectId, ids],
    );
    reply.send({ ok: true, deleted: rowCount ?? 0 });
  });

  app.delete("/api/projects/:projectId/bugs", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { rows } = await pool.query<{ run_id: string; screenshot_path: string | null }>(
      "SELECT run_id, screenshot_path FROM bugs WHERE project_id = $1",
      [projectId],
    );
    for (const r of rows) {
      unlinkBugScreenshotFile(r.run_id, r.screenshot_path);
    }
    const { rowCount } = await pool.query("DELETE FROM bugs WHERE project_id = $1", [projectId]);
    reply.send({ ok: true, deleted: rowCount ?? 0 });
  });
}
