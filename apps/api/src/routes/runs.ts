import { FastifyInstance } from "fastify";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { StorageAdapter } from "@kery/engine";
import { logger, LIVE_PREVIEW_FILENAME } from "@kery/engine";
import type { RunJobData } from "../runQueue.js";
import { markRunStopRequested } from "../runStopRedis.js";
import { mergeDbRunWithLiveSnapshot, readLiveRunSnapshotFromRedis, runEventsChannel } from "../liveRunBridge.js";
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
  authTest: z.boolean().optional(),
});

export function registerRunRoutes(
  app: FastifyInstance,
  storage: StorageAdapter,
  runQueue: Queue<RunJobData>,
  redis: Redis,
  redisUrl: string,
) {
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
        reply.send({ runId: existing.runId, status: "queued", deduplicated: true });
        return;
      }
    }

    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(req.params);
    const parsed = RunSchema.safeParse({ ...(req.body as Record<string, unknown>), projectId });
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }

    const { environmentId, testId, destinationId, authTest } = parsed.data;
    let intent = parsed.data.intent;
    let context: string | undefined;
    let maxSteps: number | undefined;
    if (authTest) maxSteps = 8;

    let dest: Awaited<ReturnType<StorageAdapter["getDestination"]>> = null;
    if (destinationId) {
      dest = await storage.getDestination(destinationId);
      if (!dest) { reply.code(404).send({ error: "destination not found" }); return; }
      intent = intent || `Inspect ${dest.normalized_route} ("${dest.title}") for bugs`;
    }

    let savedTest: Awaited<ReturnType<StorageAdapter["getSavedTest"]>> = null;
    if (testId) {
      savedTest = await storage.getSavedTest(testId);
      if (!savedTest) { reply.code(404).send({ error: "test not found" }); return; }
      intent = savedTest.intent;
      context = savedTest.context ?? undefined;
      maxSteps = savedTest.max_steps ?? undefined;
    }

    if (!intent) { reply.code(400).send({ error: "intent is required" }); return; }

    let sourceLabel: string;
    let sourceType: "test" | "page" | "adhoc";
    if (testId && savedTest) {
      sourceLabel = String(savedTest.name ?? "").trim() || "Saved test";
      sourceType = "test";
    } else if (destinationId && dest) {
      const title = String(dest.title ?? "").trim();
      sourceLabel = title || String(dest.normalized_route ?? "");
      sourceType = "page";
    } else {
      sourceLabel = authTest ? "Test auth" : intent.trim();
      if (sourceLabel.length > 500) sourceLabel = `${sourceLabel.slice(0, 497)}...`;
      sourceType = "adhoc";
    }

    const { rows: [env] } = await pool.query("SELECT * FROM environments WHERE id = $1", [environmentId]);
    if (!env) { reply.code(404).send({ error: "environment not found" }); return; }

    const authRow = await storage.getAuthConfig(projectId, environmentId);

    const run = await storage.createTestRun({
      project_id: projectId, environment_id: environmentId,
      test_id: testId ?? null, destination_id: destinationId ?? null,
      trigger_type: "manual", trigger_ref: authTest ? "auth_test" : "dashboard",
      // The job has only been enqueued here; worker flips this to `running`.
      status: "queued", started_at: new Date().toISOString(),
      source_type: sourceType,
      source_label: sourceLabel,
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

    reply.send({ runId: run.id, status: "queued" });
  });

  // SSE streaming — uses Redis Pub/Sub so the worker process can be separate
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

    // Check if run exists and is still active
    const run = await storage.getTestRun(runId);
    if (!run) {
      send({ type: "error", message: "run not found" });
      reply.raw.end();
      return;
    }

    // Run already finished — send final state immediately
    if (run.status !== "running" && run.status !== "queued") {
      send({ type: "done", run });
      reply.raw.end();
      return;
    }

    // Dedicated subscriber connection (Redis forbids pub/sub and commands on the same client)
    const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const channel = runEventsChannel(runId);
    let ended = false;

    const cleanup = async () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      try {
        await redisSub.unsubscribe(channel);
        redisSub.disconnect();
      } catch { /* ignore */ }
    };

    const heartbeat = setInterval(() => { reply.raw.write(`:keepalive\n\n`); }, 15_000);

    redisSub.on("message", (_ch: string, message: string) => {
      try {
        const payload = JSON.parse(message);
        send(payload);
        if (payload.type === "done") {
          void cleanup().then(() => reply.raw.end());
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    await redisSub.subscribe(channel);

    req.raw.on("close", () => { void cleanup(); });
  });

  // Get single run
  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    let run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    if (run.status === "running") {
      const live = await readLiveRunSnapshotFromRedis(redis, runId);
      if (live) {
        run = mergeDbRunWithLiveSnapshot(run as Record<string, unknown>, live) as typeof run;
      }
    }
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

  // Stop a run — works for both "queued" and "running" states
  app.post("/api/runs/:runId/stop", async (req, reply) => {
    const { runId } = RunIdParams.parse(req.params);
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    if (run.status !== "running" && run.status !== "queued") {
      reply.send({ ok: true, status: run.status });
      return;
    }
    try {
      await markRunStopRequested(redis, runId);
    } catch (err) {
      logger.error({ runId, err: String(err) }, "Stop: failed to set Redis signal");
      reply.code(503).send({ ok: false, error: "stop_signal_unavailable" });
      return;
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
      const cacheControl =
        safe === LIVE_PREVIEW_FILENAME
          ? "private, no-store, max-age=0"
          : "public, max-age=31536000, immutable";
      return reply
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", cacheControl)
        .send(buf);
    } catch (err) {
      logger.warn({ err: String(err), filePath }, "Bug screenshot read failed");
      reply.code(404).send({ error: "screenshot not found" });
    }
  });
}
