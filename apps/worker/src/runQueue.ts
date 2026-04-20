import { Queue, Worker, Job } from "bullmq";
import * as os from "os";
import * as path from "path";
import type { StorageAdapter } from "@kery/engine";
import {
  runOrchestratedJob, enrichBugsForRun, generateScriptWithLLM,
  createEmitter, destroyEmitter, logger, drawRedBoundingBoxOnJpeg,
  isStopRequested,
} from "@kery/engine";
import type { Redis } from "ioredis";
import { clearRunStopRequest, startRunStopPoller, runStopRedisKey } from "./runStopRedis.js";
import { createRunLiveBridge, deleteLiveRunState, runEventsChannel } from "./liveRunBridge.js";
import * as fs from "fs";

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.cwd(), "data", "videos");
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");

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

      try {
        await storage.updateTestRun(data.runId, {
          status: "running",
          started_at: new Date().toISOString(),
        });

        const runJob: any = {
          runId: data.runId,
          baseUrl: data.baseUrl,
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
          onStep: (step: any) => void live.forwardStep(step),
          onAgentPlan: (items: Array<{ text: string; status: "pending" | "done" | "current" | "failed" }>) =>
            void live.forwardAgentPlan(items),
          onActivity: (activity: { kind: "observe"; text: string; at: number }) => void live.forwardActivity(activity),
          onScreenshot: (buf: Buffer) => void live.forwardScreenshot(buf),
          onLLMCall: (call: any) => void live.forwardLlmCall(call),
          shouldStop: () => stopPoller.shouldStop() || isStopRequested(data.runId),
        };
        const result = await runOrchestratedJob(storage, runJob);

        const completedAt = new Date().toISOString();
        await materializeRunScreenshotFiles(data.runId, result.llmCalls, result.bugsFound);
        const enrichedBugs = enrichBugsForRun(data.runId, completedAt, data.triggerRef, result.bugsFound);

        const scriptLLMCalls: any[] = [];
        const onScriptLLMCall = (call: any) => {
          scriptLLMCalls.push(call);
          void live.forwardLlmCall(call);
        };

        let destRegPlan: any[] | null = null;
        if (data.destinationId && result.status === "passed" && result.stepsDetail?.length > 0) {
          const { plan } = await generateScriptWithLLM(data.intent, result.stepsDetail, onScriptLLMCall);
          if (plan.length > 0) destRegPlan = plan;
        }

        let testRegPlan: any[] | null = null;
        if (data.testId && result.status === "passed" && result.stepsDetail?.length > 0) {
          const { plan } = await generateScriptWithLLM(data.intent, result.stepsDetail, onScriptLLMCall);
          if (plan.length > 0) testRegPlan = plan;
        }

        const allLLMCalls = [...result.llmCalls, ...scriptLLMCalls].map((c, i) => ({ ...c, seq: i + 1 }));

        const costUsd = allLLMCalls.reduce(
          (s: number, c: { costUsd?: number }) => s + (typeof c?.costUsd === "number" ? c.costUsd : 0),
          0,
        );

        await storage.withTransaction(async (tx) => {
          await tx.updateTestRun(data.runId, {
            status: result.status, summary: null,
            steps_json: result.stepsDetail, bugs_json: enrichedBugs,
            llm_calls_json: allLLMCalls, completed_at: completedAt,
            video_url: result.videoUrl || null,
            cost_usd: costUsd,
          });

          await tx.persistBugsFromRun(data.projectId, data.runId, data.triggerRef, completedAt, data.environmentId, data.environmentName, enrichedBugs);

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

            if (destRegPlan) {
              await tx.updateRegressionPlan("app_tree_destinations", data.destinationId, {
                regression_plan: destRegPlan, plan_status: "ready", plan_success_count: 1,
              });
            }
          }

          if (data.testId && testRegPlan) {
            await tx.updateSavedTest(data.testId, {
              regression_plan: testRegPlan, plan_status: "ready", plan_success_count: 1,
            });
          }
        });

        const completedRun = await storage.getTestRun(data.runId);
        await live.publishDone(completedRun ?? { runId: data.runId, status: result.status, summary: null });
        emitter.emit("done", completedRun ?? { runId: data.runId, status: result.status, summary: null });
      } catch (err) {
        logger.error({ runId: data.runId, err: String(err) }, "Run job error");
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
    { connection, concurrency },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, runId: job?.data?.runId, err: String(err) }, "BullMQ job failed");
  });

  return worker;
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
