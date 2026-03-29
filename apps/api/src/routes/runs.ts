import { FastifyInstance } from "fastify";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import type { Queue } from "bullmq";
import type { StorageAdapter } from "@kery/engine";
import {
  getEmitter, requestStop, logger,
} from "@kery/engine";
import type { RunJobData } from "../runQueue.js";
import { RunIdParams, RunFilenameParams } from "./params.js";

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.cwd(), "data", "videos");
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");

// Idempotency dedup: key -> { runId, expiresAt }
const idempotencyCache = new Map<string, { runId: string; expiresAt: number }>();
const IDEMPOTENCY_TTL_MS = 30_000; // 30 seconds

const RunSchema = z.object({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  intent: z.string().min(3).optional(),
  testId: z.string().uuid().optional(),
  destinationId: z.string().uuid().optional(),
});

export function registerRunRoutes(app: FastifyInstance, storage: StorageAdapter, runQueue: Queue<RunJobData>) {
  const pool = storage.getPool() as Pool;

  app.post("/api/projects/:projectId/run", async (req, reply) => {
    // Idempotency key dedup
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const now = Date.now();
      // Evict expired entries lazily
      for (const [k, v] of idempotencyCache) {
        if (v.expiresAt < now) idempotencyCache.delete(k);
      }
      const existing = idempotencyCache.get(idempotencyKey);
      if (existing && existing.expiresAt > now) {
        reply.send({ runId: existing.runId, status: "running", deduplicated: true });
        return;
      }
    }

    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(req.params);
    const parsed = RunSchema.safeParse({ ...(req.body as Record<string, unknown>), projectId });
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }

    const { environmentId, testId, destinationId } = parsed.data;
    let intent = parsed.data.intent;
    let context: string | undefined;
    let maxSteps: number | undefined;

    if (destinationId) {
      const dest = await storage.getDestination(destinationId);
      if (!dest) { reply.code(404).send({ error: "destination not found" }); return; }
      intent = intent || `Inspect ${dest.normalized_route} ("${dest.title}") for bugs`;
    }

    if (testId) {
      const savedTest = await storage.getSavedTest(testId);
      if (!savedTest) { reply.code(404).send({ error: "test not found" }); return; }
      intent = savedTest.intent;
      context = savedTest.context ?? undefined;
      maxSteps = savedTest.max_steps ?? undefined;
    }

    if (!intent) { reply.code(400).send({ error: "intent is required" }); return; }

    const { rows: [env] } = await pool.query("SELECT * FROM environments WHERE id = $1", [environmentId]);
    if (!env) { reply.code(404).send({ error: "environment not found" }); return; }

    const authRow = await storage.getAuthConfig(projectId, environmentId);

    const run = await storage.createTestRun({
      project_id: projectId, environment_id: environmentId,
      test_id: testId ?? null, destination_id: destinationId ?? null,
      trigger_type: "manual", trigger_ref: "dashboard",
      status: "running", started_at: new Date().toISOString(),
    });

    const authConfig = authRow ? { mode: authRow.mode, ...authRow.config_json } : null;

    // Enqueue run job via BullMQ instead of setImmediate
    await runQueue.add("run", {
      runId: run.id,
      baseUrl: env.base_url,
      intent: intent!,
      projectId,
      environmentId,
      environmentName: env.name,
      auth: authConfig,
      testId,
      destinationId,
      context,
      saveScreenshots: true,
      maxSteps,
      recordVideo: process.env.RECORD_VIDEO !== "false",
      triggerRef: run.trigger_ref,
    } satisfies RunJobData);

    // Cache idempotency key
    if (idempotencyKey) {
      idempotencyCache.set(idempotencyKey, { runId: run.id, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
    }

    reply.send({ runId: run.id, status: "running" });
  });

  // SSE streaming
  app.get("/api/runs/:runId/stream", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    reply.hijack();
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    const send = (payload: object) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      (reply.raw as any).flush?.();
    };

    const emitter = getEmitter(runId);
    if (!emitter) {
      const run = await storage.getTestRun(runId);
      if (!run) send({ type: "error", message: "run not found" });
      else send({ type: "done", run });
      reply.raw.end();
      return;
    }

    const heartbeat = setInterval(() => { reply.raw.write(`:keepalive\n\n`); }, 15_000);
    const onStep = (step: any) => send({ type: "step", step });
    const onScreenshot = (data: string) => send({ type: "screenshot", data });
    const onLLMCall = (call: any) => send({ type: "llm_call", call });
    const onDone = (run: any) => { clearInterval(heartbeat); send({ type: "done", run }); reply.raw.end(); };

    emitter.on("step", onStep);
    emitter.on("screenshot", onScreenshot);
    emitter.on("llm_call", onLLMCall);
    emitter.once("done", onDone);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      emitter.off("step", onStep);
      emitter.off("screenshot", onScreenshot);
      emitter.off("llm_call", onLLMCall);
      emitter.off("done", onDone);
    });
  });

  // Get single run
  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    reply.send({ run });
  });

  // Get bugs for a specific run
  app.get("/api/runs/:runId/bugs", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const { rows: bugs } = await pool.query(
      "SELECT * FROM bugs WHERE run_id = $1 ORDER BY step_index ASC, created_at ASC",
      [runId],
    );
    reply.send({ bugs });
  });

  // Stop a running run
  app.post("/api/runs/:runId/stop", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    if (run.status !== "running") { reply.send({ ok: true, status: run.status }); return; }
    const stopped = requestStop(runId);
    if (!stopped) {
      // No active emitter — force-mark as failed directly
      await storage.updateTestRun(runId, {
        status: "failed", summary: "Stopped by user", completed_at: new Date().toISOString(),
      });
    }
    reply.send({ ok: true });
  });

  // Serve run video recording (Range support required for reliable <video> playback)
  app.get("/api/runs/:runId/video", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const videoPath = path.join(VIDEOS_DIR, `${runId}.webm`);
    if (!fs.existsSync(videoPath)) {
      reply.code(404).send({ error: "video not found" });
      return;
    }
    const stat = fs.statSync(videoPath);
    const size = stat.size;
    if (size === 0) {
      logger.warn({ runId, videoPath }, "Video file is empty on disk");
      reply.code(404).send({ error: "video empty" });
      return;
    }

    const range = req.headers.range;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "video/webm");
    reply.header("Cache-Control", "private, max-age=3600");

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/i.exec(String(range).trim());
      if (m) {
        const start = Number(m[1]);
        let end = m[2] === "" ? size - 1 : Number(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          reply.code(416).header("Content-Range", `bytes */${size}`).send();
          return;
        }
        end = Math.min(end, size - 1);
        const chunkLength = end - start + 1;
        reply.code(206);
        reply.header("Content-Length", chunkLength);
        reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
        return reply.send(fs.createReadStream(videoPath, { start, end }));
      }
    }

    reply.header("Content-Length", size);
    return reply.send(fs.createReadStream(videoPath));
  });

  // Delete a run and its associated video/screenshot files
  app.delete("/api/runs/:runId", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }

    // Delete video file
    const videoPath = path.join(VIDEOS_DIR, `${runId}.webm`);
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch (err) {
      logger.warn({ err: String(err), runId }, "Failed to delete video file");
    }

    // Delete screenshot directory
    const screenshotDir = path.join(SCREENSHOTS_DIR, runId);
    try { if (fs.existsSync(screenshotDir)) fs.rmSync(screenshotDir, { recursive: true, force: true }); } catch (err) {
      logger.warn({ err: String(err), runId }, "Failed to delete screenshot directory");
    }

    // Delete run from DB
    await pool.query("DELETE FROM bugs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM test_runs WHERE id = $1", [runId]);
    reply.send({ ok: true });
  });

  // Serve bug screenshot (buffer, not stream + Content-Length — Fastify can emit an empty body otherwise)
  app.get("/api/bugs/:runId/:filename", async (req, reply) => {
    const { runId, filename } = RunFilenameParams.parse(req.params);
    const safe = path.basename(filename);
    const filePath = path.join(SCREENSHOTS_DIR, runId, safe);
    if (!fs.existsSync(filePath)) {
      reply.code(404).send({ error: "screenshot not found" });
      return;
    }
    try {
      const buf = await fs.promises.readFile(filePath);
      return reply
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(buf);
    } catch (err) {
      logger.warn({ err: String(err), filePath }, "Bug screenshot read failed");
      reply.code(404).send({ error: "screenshot not found" });
    }
  });
}
