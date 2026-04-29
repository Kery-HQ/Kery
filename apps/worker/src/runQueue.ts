import { Queue, Worker, Job } from "bullmq";
import * as os from "os";
import * as path from "path";
import type { StorageAdapter } from "@kery/engine";
import {
  runOrchestratedJob, enrichBugsForRun,
  createEmitter, destroyEmitter, logger, drawRedBoundingBoxOnJpeg,
  isStopRequested, updateEngineConfig, rewriteForDocker,
} from "@kery/engine";
import { decryptValue } from "@kery/db";
import type { Redis } from "ioredis";
import { clearRunStopRequest, startRunStopPoller, runStopRedisKey } from "./runStopRedis.js";
import { createRunLiveBridge, deleteLiveRunState, runEventsChannel } from "./liveRunBridge.js";
import { config } from "./config.js";
import * as fs from "fs";

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.cwd(), "data", "videos");
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");
const BUGS_SCREENSHOTS_DIR = path.join(SCREENSHOTS_DIR, "bugs");

export const RUN_QUEUE_NAME = "kery-runs";

export interface RunJobData {
  runId: string;
  baseUrl: string;
  intent: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  auth: any;
  testId?: string;
  destinationId?: string;
  context?: string;
  saveScreenshots?: boolean;
  maxSteps?: number;
  recordVideo: boolean;
  triggerRef: string;
}

export function createRunQueue(redisUrl: string) {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
  };

  const queue = new Queue(RUN_QUEUE_NAME, { connection });
  return { queue, connection };
}

/** Auto-detect concurrency: ~1 browser per 512MB available memory, min 1, max 10 */
function detectConcurrency(): number {
  const freeMem = os.freemem();
  const concurrency = Math.max(1, Math.min(10, Math.floor(freeMem / (512 * 1024 * 1024))));
  logger.info({ freeMem, concurrency }, "Auto-detected run queue concurrency");
  return concurrency;
}

/** Refresh LLM/API-key config from DB before each run (DB overrides env defaults). */
async function refreshEngineConfigFromDb(storage: StorageAdapter): Promise<void> {
  const baseConfig = {
    openaiApiKey: config.openaiApiKey,
    openrouterApiKey: config.openrouterApiKey,
    anthropicApiKey: config.anthropicApiKey,
    geminiApiKey: config.geminiApiKey,
    agentModel: config.agentModel,
    auxiliaryModel: config.auxiliaryModel,
    reviewAgentModel: config.reviewAgentModel,
    stagehandModel: config.stagehandModel,
    modelPriceUsdPerMillion: {},
  };
  updateEngineConfig(baseConfig);

  try {
    const all = await storage.getSettings();

    const keyOverrides: Record<string, string> = {};
    const keyMap: Record<string, string> = {
      "apiKey.openai": "openaiApiKey",
      "apiKey.anthropic": "anthropicApiKey",
      "apiKey.gemini": "geminiApiKey",
      "apiKey.openrouter": "openrouterApiKey",
    };
    for (const [dbKey, cfgKey] of Object.entries(keyMap)) {
      if (all[dbKey]) keyOverrides[cfgKey] = decryptValue(all[dbKey]);
    }

    const modelOverrides: Record<string, string> = {};
    const modelMap: Record<string, string> = {
      "model.agentModel": "agentModel",
      "model.reviewAgentModel": "reviewAgentModel",
      "model.stagehandModel": "stagehandModel",
    };
    for (const [dbKey, cfgKey] of Object.entries(modelMap)) {
      if (all[dbKey]) modelOverrides[cfgKey] = all[dbKey];
    }
    const auxiliaryModel =
      all["model.auxiliaryModel"] ??
      all["model.crawlModel"] ??
      all["model.scriptModel"] ??
      all["model.summaryModel"] ??
      all["model.reviewModel"];
    if (auxiliaryModel) modelOverrides.auxiliaryModel = auxiliaryModel;

    const modelPriceUsdPerMillion: Record<string, { input: number; output: number }> = {};
    const priceMap: Record<string, string> = {
      "modelPrice.agentModel": "agentModel",
      "modelPrice.reviewAgentModel": "reviewAgentModel",
      "modelPrice.stagehandModel": "stagehandModel",
    };
    for (const [dbKey, cfgKey] of Object.entries(priceMap)) {
      const raw = all[dbKey];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { input?: unknown; output?: unknown };
        if (typeof parsed.input === "number" && typeof parsed.output === "number") {
          modelPriceUsdPerMillion[cfgKey] = { input: parsed.input, output: parsed.output };
        }
      } catch {
        /* ignore bad JSON */
      }
    }
    const auxiliaryPriceRaw =
      all["modelPrice.auxiliaryModel"] ??
      all["modelPrice.crawlModel"] ??
      all["modelPrice.scriptModel"] ??
      all["modelPrice.summaryModel"] ??
      all["modelPrice.reviewModel"];
    if (auxiliaryPriceRaw) {
      try {
        const parsed = JSON.parse(auxiliaryPriceRaw) as { input?: unknown; output?: unknown };
        if (typeof parsed.input === "number" && typeof parsed.output === "number") {
          modelPriceUsdPerMillion.auxiliaryModel = { input: parsed.input, output: parsed.output };
        }
      } catch {
        /* ignore bad JSON */
      }
    }

    updateEngineConfig({
      ...(Object.keys(keyOverrides).length > 0 ? keyOverrides : {}),
      ...(Object.keys(modelOverrides).length > 0 ? modelOverrides : {}),
      modelPriceUsdPerMillion,
    });
  } catch {
    // settings table may not exist yet — env defaults already applied above
  }
}

export function createRunWorker(
  connection: { host: string; port: number; password?: string },
  storage: StorageAdapter,
  redis: Redis,
  redisPub: Redis,
) {
  const concurrency = detectConcurrency();

  const worker = new Worker<RunJobData>(
    RUN_QUEUE_NAME,
    async (job: Job<RunJobData>) => {
      const data = job.data;
      const emitter = createEmitter(data.runId);
      const live = createRunLiveBridge({
        redis,
        redisPub,
        runId: data.runId,
        screenshotsDir: SCREENSHOTS_DIR,
      });
      // If the user already requested stop before this job was picked up, fail it immediately.
      const alreadyStopped = await redis.get(runStopRedisKey(data.runId)).then(v => v === "1").catch(() => false);
      if (alreadyStopped) {
        await clearRunStopRequest(redis, data.runId).catch(() => {});
        await storage.updateTestRun(data.runId, {
          status: "failed", summary: "Stopped by user", completed_at: new Date().toISOString(),
        });
        const stoppedRun = await storage.getTestRun(data.runId).catch(() => null);
        await redisPub.publish(runEventsChannel(data.runId), JSON.stringify({ type: "done", run: stoppedRun ?? { runId: data.runId, status: "failed", summary: "Stopped by user" } })).catch(() => {});
        return;
      }

      const stopPoller = startRunStopPoller(redis, data.runId);

      // Buffers for incremental Postgres persistence every INCREMENTAL_FLUSH_EVERY items.
      // Declared outside try/catch so catch block can flush remaining items on error.
      const INCREMENTAL_FLUSH_EVERY = 10;
      const stepBuffer: any[] = [];
      const llmCallBuffer: any[] = [];
      const activityBuffer: any[] = [];
      let latestAgentPlan: Array<{ text: string; status: "pending" | "done" | "current" | "failed" }> = [];

      const planCurrentIndex = (
        items: Array<{ text: string; status: "pending" | "done" | "current" | "failed" }>,
      ): number | null => {
        const idx = items.findIndex((i) => i.status === "current");
        return idx >= 0 ? idx : null;
      };

      const flushSteps = async () => {
        if (stepBuffer.length === 0) return;
        const batch = stepBuffer.splice(0, stepBuffer.length);
        await storage.appendRunSteps(data.runId, batch).catch((err: unknown) => {
          logger.warn({ err, runId: data.runId }, "Incremental step flush failed");
        });
      };

      const flushLlmCalls = async () => {
        if (llmCallBuffer.length === 0) return;
        const batch = llmCallBuffer.splice(0, llmCallBuffer.length);
        await storage.appendRunLlmCalls(data.runId, batch).catch((err: unknown) => {
          logger.warn({ err, runId: data.runId }, "Incremental LLM call flush failed");
        });
      };

      try {
        await refreshEngineConfigFromDb(storage);
        await storage.updateTestRun(data.runId, {
          status: "running",
          started_at: new Date().toISOString(),
        });

        const runJob: any = {
          runId: data.runId,
          baseUrl: rewriteForDocker(data.baseUrl),
          intent: data.intent,
          projectId: data.projectId,
          auth: data.auth,
          testId: data.testId,
          destinationId: data.destinationId,
          context: data.context,
          saveScreenshots: data.saveScreenshots ?? true,
          maxSteps: data.maxSteps,
          recordVideo: data.recordVideo,
          videosDir: VIDEOS_DIR,
          triggerRef: data.triggerRef,
          onStep: (step: any) => {
            void live.forwardStep(step);
            const at = typeof step?.at === "number" ? step.at : Date.now();
            activityBuffer.push({ type: "step", at, step });
            void live.forwardReplayProgress(typeof step?.index === "number" ? step.index : null, planCurrentIndex(latestAgentPlan), at);
            stepBuffer.push(step);
            if (stepBuffer.length >= INCREMENTAL_FLUSH_EVERY) void flushSteps();
          },
          onAgentPlan: (items: Array<{ text: string; status: "pending" | "done" | "current" | "failed" }>) => {
            latestAgentPlan = Array.isArray(items) ? items : [];
            const at = Date.now();
            activityBuffer.push({ type: "plan", at, items: latestAgentPlan });
            void live.forwardAgentPlan(latestAgentPlan);
            void live.forwardReplayProgress(null, planCurrentIndex(latestAgentPlan), at);
          },
          onActivity: (activity: { kind: "observe"; text: string; at: number }) => {
            activityBuffer.push({
              type: "activity",
              at: typeof activity?.at === "number" ? activity.at : Date.now(),
              activity,
            });
            void live.forwardActivity(activity);
          },
          onScreenshot: (buf: Buffer) => void live.forwardScreenshot(buf),
          onLLMCall: (call: any) => {
            void live.forwardLlmCall(call);
            llmCallBuffer.push(call);
            if (llmCallBuffer.length >= INCREMENTAL_FLUSH_EVERY) void flushLlmCalls();
          },
          shouldStop: () => stopPoller.shouldStop() || isStopRequested(data.runId),
        };
        const result = await runOrchestratedJob(storage, runJob);

        const completedAt = new Date().toISOString();
        await materializeRunScreenshotFiles(data.runId, result.llmCalls, result.bugsFound);
        const enrichedBugs = enrichBugsForRun(data.runId, completedAt, data.triggerRef, result.bugsFound);

        const allLLMCalls = result.llmCalls.map((c, i) => ({ ...c, seq: i + 1 }));

        const costUsd = allLLMCalls.reduce(
          (s: number, c: { costUsd?: number }) => s + (typeof c?.costUsd === "number" ? c.costUsd : 0),
          0,
        );

        await storage.withTransaction(async (tx) => {
          await tx.updateTestRun(data.runId, {
            status: result.status, summary: null,
            steps_json: result.stepsDetail, bugs_json: enrichedBugs,
            activity_json: activityBuffer,
            agent_plan_json: latestAgentPlan,
            llm_calls_json: allLLMCalls, completed_at: completedAt,
            video_url: result.videoUrl || null,
            recording_started_at: result.recordingStartedAt ?? null,
            cost_usd: costUsd,
          });

          const persistResult = await tx.persistBugsFromRun(data.projectId, data.runId, data.triggerRef, completedAt, data.environmentId, data.environmentName, enrichedBugs);
          await moveBugScreenshotsToOwnDir(data.runId, persistResult.insertedBugs, storage);

          if (data.destinationId) {
            await tx.upsertRunCoverage(data.runId, data.destinationId, enrichedBugs.length);
            const healthData: any = { last_inspected_at: completedAt };
            if (enrichedBugs.length > 0) {
              healthData.health_status = "issues";
              healthData.issues_count = enrichedBugs.length;
            } else {
              healthData.health_status = "clean";
              healthData.issues_count = 0;
            }
            await tx.updateDestinationHealth(data.destinationId, healthData);

          }
        });

        const completedRun = await storage.getTestRun(data.runId);
        await live.publishDone(completedRun ?? { runId: data.runId, status: result.status, summary: null });
        emitter.emit("done", completedRun ?? { runId: data.runId, status: result.status, summary: null });
      } catch (err) {
        logger.error({ runId: data.runId, err: String(err) }, "Run job error");
        // Flush any buffered steps/LLM calls accumulated before the crash so data isn't lost
        await flushSteps().catch(() => {});
        await flushLlmCalls().catch(() => {});
        await storage.updateTestRun(data.runId, {
          status: "failed", summary: String(err), completed_at: new Date().toISOString(),
        });
        const failedRun = await storage.getTestRun(data.runId).catch(() => null);
        await live.publishDone(failedRun ?? { runId: data.runId, status: "failed", summary: String(err) });
        emitter.emit("done", failedRun ?? { runId: data.runId, status: "failed", summary: String(err) });
      } finally {
        stopPoller.dispose();
        await clearRunStopRequest(redis, data.runId).catch(() => {});
        await deleteLiveRunState(redis, data.runId, SCREENSHOTS_DIR);
        destroyEmitter(data.runId);
      }
    },
    {
      connection,
      concurrency,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 }, // keep last 500 failed jobs for post-mortem debugging
    },
  );

  worker.on("failed", (job, err) => {
    const runId = job?.data?.runId;
    logger.error({ jobId: job?.id, runId, err: String(err) }, "BullMQ job failed");
    // Best-effort: mark the run as failed in Postgres if it wasn't already marked above
    if (runId) {
      storage.getTestRun(runId)
        .then((run) => {
          if (run && run.status === "running") {
            return storage.updateTestRun(runId, {
              status: "failed",
              summary: `Worker crash: ${String(err).slice(0, 300)}`,
              completed_at: new Date().toISOString(),
            });
          }
        })
        .catch((e) => logger.warn({ runId, err: String(e) }, "BullMQ failed handler: DB update failed"));
    }
  });

  return worker;
}

/** Move bug screenshot files out of the run directory into their own bug-scoped location. */
async function moveBugScreenshotsToOwnDir(
  runId: string,
  insertedBugs: Array<{ id: string; screenshotPath: string | null }>,
  storage: StorageAdapter,
): Promise<void> {
  if (insertedBugs.length === 0) return;
  try { fs.mkdirSync(BUGS_SCREENSHOTS_DIR, { recursive: true }); } catch { /* exists */ }
  for (const { id, screenshotPath } of insertedBugs) {
    if (!screenshotPath) continue;
    const oldPath = path.join(SCREENSHOTS_DIR, runId, path.basename(screenshotPath));
    const newFilename = `${id}.jpg`;
    const newPath = path.join(BUGS_SCREENSHOTS_DIR, newFilename);
    try {
      fs.renameSync(oldPath, newPath);
      await storage.updateBugScreenshotPath(id, newFilename);
    } catch (err) {
      logger.warn({ runId, bugId: id, err: String(err) }, "Failed to move bug screenshot");
    }
  }
}

/** Write vision/bug JPEGs to SCREENSHOTS_DIR; replace inline base64 with filename-only refs. */
async function materializeRunScreenshotFiles(runId: string, llmCalls: any[], bugSteps: any[]): Promise<void> {
  const dir = path.join(SCREENSHOTS_DIR, runId);
  let dirReady = false;
  const ensureDir = () => {
    if (!dirReady) {
      fs.mkdirSync(dir, { recursive: true });
      dirReady = true;
    }
  };

  let bugFileIdx = 0;
  for (const step of bugSteps) {
    const raw = step.screenshotBase64;
    if (raw == null || raw === "") { delete step.screenshotBase64; continue; }
    if (typeof raw !== "string") { delete step.screenshotBase64; continue; }
    if (raw.startsWith("/api/") || raw.startsWith("http")) {
      const tail = raw.split("/").filter(Boolean).pop() ?? "";
      step.screenshotPath = path.basename(tail.split("?")[0]);
      delete step.screenshotBase64;
      continue;
    }
    try {
      ensureDir();
      const filename = `bug-${bugFileIdx++}.jpg`;
      let buf: Uint8Array = Buffer.from(raw, "base64");
      const reg = step.region;
      if (reg && typeof reg === "object" && typeof reg.x === "number" && typeof reg.y === "number" && typeof reg.w === "number" && typeof reg.h === "number") {
        buf = await drawRedBoundingBoxOnJpeg(Buffer.from(buf), { x: reg.x, y: reg.y, w: reg.w, h: reg.h });
      }
      fs.writeFileSync(path.join(dir, filename), buf);
      step.screenshotPath = filename;
      delete step.screenshotBase64;
    } catch (err) {
      logger.warn({ runId, err: String(err) }, "Bug screenshot write failed");
      delete step.screenshotBase64;
    }
  }

  for (const call of llmCalls) {
    const seq = typeof call.seq === "number" ? call.seq : 0;
    const list = call.imageBase64s;
    if (Array.isArray(list) && list.length > 0) {
      const paths: string[] = [];
      try {
        ensureDir();
        for (let i = 0; i < list.length; i++) {
          const raw = list[i];
          if (raw == null || raw === "" || typeof raw !== "string") continue;
          if (raw.startsWith("/api/") || raw.startsWith("http")) {
            const tail = raw.split("/").filter(Boolean).pop() ?? "";
            paths.push(path.basename(tail.split("?")[0]));
            continue;
          }
          const filename = list.length === 1 ? `llm-${seq}.jpg` : `llm-${seq}-${i}.jpg`;
          fs.writeFileSync(path.join(dir, filename), Buffer.from(raw, "base64"));
          paths.push(filename);
        }
        if (paths.length > 0) { call.imagePaths = paths; call.imagePath = paths[0]; }
      } catch (err) {
        logger.warn({ runId, seq, err: String(err) }, "LLM screenshot batch write failed");
      }
      delete call.imageBase64s;
      delete call.imageBase64;
      continue;
    }

    const raw = call.imageBase64;
    if (raw == null || raw === "") { delete call.imageBase64; continue; }
    if (typeof raw !== "string") { delete call.imageBase64; continue; }
    if (raw.startsWith("/api/") || raw.startsWith("http")) {
      const tail = raw.split("/").filter(Boolean).pop() ?? "";
      call.imagePath = path.basename(tail.split("?")[0]);
      call.imagePaths = [call.imagePath];
      delete call.imageBase64;
      continue;
    }
    try {
      ensureDir();
      const filename = `llm-${seq}.jpg`;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(raw, "base64"));
      call.imagePath = filename;
      call.imagePaths = [filename];
      delete call.imageBase64;
    } catch (err) {
      logger.warn({ runId, seq, err: String(err) }, "LLM screenshot write failed");
      delete call.imageBase64;
    }
  }
}
