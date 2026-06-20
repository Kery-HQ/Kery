import { Queue, Worker, Job } from "bullmq";
import * as path from "path";
import type { StorageAdapter } from "@kery/engine";
import {
  runOrchestratedJob, enrichBugsForRun,
  createEmitter, destroyEmitter, logger, drawRedBoundingBoxOnJpeg,
  isStopRequested, updateEngineConfig, serializeError, withRunCorrelation, auditConnection,
  type RunResult,
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

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY_LIMIT = 10;

/** Read concurrency from DB settings, falling back to 3 if not set. */
async function readConcurrencyFromDb(storage: StorageAdapter): Promise<number> {
  try {
    const all = await storage.getSettings();
    const raw = all["platform.maxConcurrency"];
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= MAX_CONCURRENCY_LIMIT) return n;
    }
  } catch {}
  return DEFAULT_CONCURRENCY;
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

function truncateForSummary(value: string, max = 1000): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function summarizeFailedResult(result: RunResult): string | null {
  if (result.status !== "failed") return null;
  if (result.error?.trim()) return truncateForSummary(result.error.trim());
  const failedStep = [...result.stepsDetail]
    .reverse()
    .find((step) => step.status === "failed" && (step.error || step.reasoning));
  if (failedStep?.error) return truncateForSummary(failedStep.error);
  if (failedStep?.reasoning) return truncateForSummary(failedStep.reasoning);
  return "Run failed";
}

function errorMessage(err: unknown): string {
  const serialized = serializeError(err);
  return typeof serialized.message === "string" ? serialized.message : String(err);
}

async function logBaseUrlPreflight(runId: string, baseUrl: string): Promise<void> {
  logger.info({ runId, baseUrl }, "Worker URL preflight starting");
  const audit = await auditConnection(baseUrl);
  const payload = {
    runId,
    baseUrl,
    status: audit.status,
    summary: audit.summary,
    runtime: audit.runtime,
    probe: audit.probe,
    observations: audit.observations,
    recommendations: audit.recommendations,
  };
  if (audit.status === "failed") {
    logger.warn(payload, "Worker URL preflight failed");
  } else if (audit.status === "warning") {
    logger.warn(payload, "Worker URL preflight completed with warnings");
  } else {
    logger.info(payload, "Worker URL preflight completed");
  }
}

export async function createRunWorker(
  connection: { host: string; port: number; password?: string },
  storage: StorageAdapter,
  redis: Redis,
  redisPub: Redis,
  queue: Queue<RunJobData>,
) {
  const concurrency = await readConcurrencyFromDb(storage);
  logger.info({ concurrency }, "Run queue concurrency");

  async function logQueueSnapshot(reason: string): Promise<void> {
    try {
      const [counts, jobs] = await Promise.all([
        queue.getJobCounts("waiting", "active", "delayed", "prioritized", "paused", "failed"),
        queue.getJobs(["waiting", "delayed", "prioritized", "paused", "active"], 0, 10),
      ]);
      logger.info(
        {
          queue: RUN_QUEUE_NAME,
          reason,
          counts,
          sample: jobs.map((job) => ({
            jobId: job.id,
            runId: job.data?.runId,
            triggerRef: job.data?.triggerRef,
          })),
        },
        "BullMQ queue snapshot",
      );
    } catch (err) {
      logger.warn({ queue: RUN_QUEUE_NAME, reason, err: serializeError(err) }, "BullMQ queue snapshot failed");
    }
  }

  const worker = new Worker<RunJobData>(
    RUN_QUEUE_NAME,
    async (job: Job<RunJobData>) => {
      const data = job.data;
      return withRunCorrelation(data.runId, async () => {
        const emitter = createEmitter(data.runId);
        const live = createRunLiveBridge({
          redis,
          redisPub,
          runId: data.runId,
          screenshotsDir: SCREENSHOTS_DIR,
        });
        logger.info(
          {
            jobId: job.id,
            attemptsMade: job.attemptsMade,
            runId: data.runId,
            projectId: data.projectId,
            environmentId: data.environmentId,
            environmentName: data.environmentName,
            baseUrl: data.baseUrl,
            triggerRef: data.triggerRef,
            testId: data.testId,
            maxSteps: data.maxSteps,
            recordVideo: data.recordVideo,
            authMode: data.auth?.mode ?? null,
            intentPreview: data.intent.slice(0, 200),
          },
          "Run job picked up by worker",
        );
        // If the user already requested stop before this job was picked up, fail it immediately.
        const alreadyStopped = await redis.get(runStopRedisKey(data.runId)).then(v => v === "1").catch(() => false);
        if (alreadyStopped) {
          logger.info({ jobId: job.id, runId: data.runId }, "Run job skipped because stop was already requested");
          await clearRunStopRequest(redis, data.runId).catch(() => {});
          await storage.updateTestRun(data.runId, {
            status: "failed", summary: "Stopped by user", completed_at: new Date().toISOString(),
          });
          const stoppedRun = await storage.getTestRun(data.runId).catch(() => null);
          await redisPub.publish(runEventsChannel(data.runId), JSON.stringify({ type: "done", run: stoppedRun ?? { runId: data.runId, status: "failed", summary: "Stopped by user" } })).catch(() => {});
          await deleteLiveRunState(redis, data.runId, SCREENSHOTS_DIR).catch((err) => {
            logger.warn({ jobId: job.id, runId: data.runId, err: serializeError(err) }, "Stopped run live state cleanup failed");
          });
          destroyEmitter(data.runId);
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
            logger.warn({ err: serializeError(err), runId: data.runId }, "Incremental step flush failed");
          });
        };

        const flushLlmCalls = async () => {
          if (llmCallBuffer.length === 0) return;
          const batch = llmCallBuffer.splice(0, llmCallBuffer.length);
          await storage.appendRunLlmCalls(data.runId, batch).catch((err: unknown) => {
            logger.warn({ err: serializeError(err), runId: data.runId }, "Incremental LLM call flush failed");
          });
        };

        try {
          await refreshEngineConfigFromDb(storage);
          await storage.updateTestRun(data.runId, {
            status: "running",
            started_at: new Date().toISOString(),
          });
          logger.info({ jobId: job.id, runId: data.runId, baseUrl: data.baseUrl }, "Run marked running");
          await logBaseUrlPreflight(data.runId, data.baseUrl);

          const runJob: any = {
            runId: data.runId,
            baseUrl: data.baseUrl,
            intent: data.intent,
            projectId: data.projectId,
            auth: data.auth,
            testId: data.testId,
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
          const failureSummary = summarizeFailedResult(result);
          logger.info(
            {
              jobId: job.id,
              runId: data.runId,
              status: result.status,
              failureSummary,
              steps: result.stepsDetail.length,
              bugs: result.bugsFound.length,
              llmCalls: result.llmCalls.length,
              videoUrl: result.videoUrl ?? null,
            },
            "Run orchestrator finished",
          );

          const completedAt = new Date().toISOString();
          await materializeRunScreenshotFiles(data.runId, result.llmCalls, result.bugsFound);
          const enrichedBugs = enrichBugsForRun(data.runId, completedAt, data.triggerRef, result.bugsFound);

          const allLLMCalls = result.llmCalls.map((c, i) => ({ ...c, seq: i + 1 }));

          const costUsd = allLLMCalls.reduce(
            (s: number, c: { costUsd?: number }) => s + (typeof c?.costUsd === "number" ? c.costUsd : 0),
            0,
          );

          let insertedBugs: Array<{ id: string; screenshotPath: string | null }> = [];
          await storage.withTransaction(async (tx) => {
            await tx.updateTestRun(data.runId, {
              status: result.status, summary: failureSummary,
              steps_json: result.stepsDetail, bugs_json: enrichedBugs,
              activity_json: activityBuffer,
              agent_plan_json: latestAgentPlan,
              llm_calls_json: allLLMCalls, completed_at: completedAt,
              video_url: result.videoUrl || null,
              recording_started_at: result.recordingStartedAt ?? null,
              cost_usd: costUsd,
            });

            const persistResult = await tx.persistBugsFromRun(data.projectId, data.runId, data.triggerRef, completedAt, data.environmentId, data.environmentName, enrichedBugs);
            insertedBugs = persistResult.insertedBugs;

          });

          // Move bug screenshots after transaction commits so updateBugScreenshotPath can see the inserted rows
          await moveBugScreenshotsToOwnDir(data.runId, insertedBugs, storage);
          logger.info(
            {
              jobId: job.id,
              runId: data.runId,
              status: result.status,
              insertedBugs: insertedBugs.length,
              costUsd,
            },
            "Run persisted",
          );

          const completedRun = await storage.getTestRun(data.runId);
          await live.publishDone(completedRun ?? { runId: data.runId, status: result.status, summary: failureSummary });
          emitter.emit("done", completedRun ?? { runId: data.runId, status: result.status, summary: failureSummary });
          logger.info({ jobId: job.id, runId: data.runId, status: result.status }, "Run done event published");
        } catch (err) {
          const summary = errorMessage(err);
          logger.error({ jobId: job.id, runId: data.runId, err: serializeError(err) }, "Run job error");
          // Flush any buffered steps/LLM calls accumulated before the crash so data isn't lost
          await flushSteps().catch(() => {});
          await flushLlmCalls().catch(() => {});
          await storage.updateTestRun(data.runId, {
            status: "failed", summary, completed_at: new Date().toISOString(),
          });
          const failedRun = await storage.getTestRun(data.runId).catch(() => null);
          await live.publishDone(failedRun ?? { runId: data.runId, status: "failed", summary });
          emitter.emit("done", failedRun ?? { runId: data.runId, status: "failed", summary });
        } finally {
          logger.info({ jobId: job.id, runId: data.runId }, "Run job cleanup starting");
          stopPoller.dispose();
          await clearRunStopRequest(redis, data.runId).catch(() => {});
          await deleteLiveRunState(redis, data.runId, SCREENSHOTS_DIR);
          destroyEmitter(data.runId);
          logger.info({ jobId: job.id, runId: data.runId }, "Run job cleanup finished");
        }
      });
    },
    {
      connection,
      concurrency,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 }, // keep last 500 failed jobs for post-mortem debugging
    },
  );

  worker.on("ready", () => {
    logger.info({ queue: RUN_QUEUE_NAME, concurrency }, "BullMQ worker ready");
    void logQueueSnapshot("worker-ready");
  });

  worker.on("active", (job) => {
    logger.info({ jobId: job.id, runId: job.data.runId }, "BullMQ job active");
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, runId: job.data.runId }, "BullMQ job completed");
  });

  worker.on("stalled", (jobId) => {
    logger.warn({ jobId }, "BullMQ job stalled");
  });

  worker.on("drained", () => {
    logger.info({ queue: RUN_QUEUE_NAME }, "BullMQ worker drained queue");
    void logQueueSnapshot("worker-drained");
  });

  worker.on("error", (err) => {
    logger.error({ err: serializeError(err) }, "BullMQ worker error");
  });

  worker.on("closed", () => {
    logger.warn({ queue: RUN_QUEUE_NAME }, "BullMQ worker closed");
  });

  worker.on("failed", (job, err) => {
    const runId = job?.data?.runId;
    logger.error({ jobId: job?.id, runId, err: serializeError(err) }, "BullMQ job failed");
    // Best-effort: mark the run as failed in Postgres if it wasn't already marked above
    if (runId) {
      storage.getTestRun(runId)
        .then((run) => {
          if (run && (run.status === "running" || run.status === "queued")) {
            return storage.updateTestRun(runId, {
              status: "failed",
              summary: `Worker crash: ${errorMessage(err).slice(0, 300)}`,
              completed_at: new Date().toISOString(),
            });
          }
        })
        .catch((e) => logger.warn({ runId, err: serializeError(e) }, "BullMQ failed handler: DB update failed"));
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
