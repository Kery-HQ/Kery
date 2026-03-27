import { Queue, Worker, Job } from "bullmq";
import * as os from "os";
import * as path from "path";
import type { StorageAdapter } from "@kery/engine";
import {
  runOrchestratedJob, enrichBugsForRun, generateRegressionPlan,
  createEmitter, destroyEmitter, logger,
} from "@kery/engine";

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.cwd(), "data", "videos");
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");

export const RUN_QUEUE_NAME = "kery:runs";

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

/** Auto-detect concurrency: ~1 browser per 512MB available memory, min 1, max 10 */
function detectConcurrency(): number {
  const freeMem = os.freemem();
  const concurrency = Math.max(1, Math.min(10, Math.floor(freeMem / (512 * 1024 * 1024))));
  logger.info({ freeMem, concurrency }, "Auto-detected run queue concurrency");
  return concurrency;
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

export function createRunWorker(
  connection: { host: string; port: number; password?: string },
  storage: StorageAdapter,
) {
  const concurrency = detectConcurrency();

  const worker = new Worker<RunJobData>(
    RUN_QUEUE_NAME,
    async (job: Job<RunJobData>) => {
      const data = job.data;
      const emitter = createEmitter(data.runId);

      try {
        const result = await runOrchestratedJob(storage, {
          runId: data.runId,
          baseUrl: data.baseUrl,
          intent: data.intent,
          projectId: data.projectId,
          auth: data.auth,
          testId: data.testId,
          destinationId: data.destinationId,
          context: data.context,
          saveScreenshots: data.saveScreenshots,
          maxSteps: data.maxSteps,
          recordVideo: data.recordVideo,
          videosDir: VIDEOS_DIR,
          onStep: (step) => emitter.emit("step", step),
          onScreenshot: (buf) => emitter.emit("screenshot", buf.toString("base64")),
          onLLMCall: (call) => emitter.emit("llm_call", call),
        });

        const completedAt = new Date().toISOString();
        const enrichedBugs = enrichBugsForRun(data.runId, completedAt, data.triggerRef, result.bugsFound, result.stepsDetail);

        extractBugScreenshots(data.runId, enrichedBugs);

        // Wrap all post-run DB writes in a transaction for atomicity
        await storage.withTransaction(async (tx) => {
          await tx.updateTestRun(data.runId, {
            status: result.status, summary: result.summary,
            steps_json: result.stepsDetail, bugs_json: enrichedBugs,
            llm_calls_json: result.llmCalls, completed_at: completedAt,
            video_url: result.videoUrl || null,
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

            if ((result.status === "passed" || result.status === "partial") && result.stepsDetail?.length > 0) {
              const regPlan = generateRegressionPlan(result.stepsDetail);
              if (regPlan.length > 0) {
                await tx.updateRegressionPlan("app_tree_destinations", data.destinationId, {
                  regression_plan: regPlan, plan_status: "ready", plan_success_count: 1,
                });
              }
            }
          }

          if (data.testId && (result.status === "passed" || result.status === "partial") && result.stepsDetail?.length > 0) {
            const regPlan = generateRegressionPlan(result.stepsDetail);
            if (regPlan.length > 0) {
              await tx.updateSavedTest(data.testId, {
                regression_plan: regPlan, plan_status: "ready", plan_success_count: 1,
              });
            }
          }
        });

        const completedRun = await storage.getTestRun(data.runId);
        emitter.emit("done", completedRun ?? { runId: data.runId, status: result.status, summary: result.summary });
      } catch (err) {
        logger.error({ runId: data.runId, err: String(err) }, "Run job error");
        await storage.updateTestRun(data.runId, {
          status: "failed", summary: String(err), completed_at: new Date().toISOString(),
        });
        const failedRun = await storage.getTestRun(data.runId).catch(() => null);
        emitter.emit("done", failedRun ?? { runId: data.runId, status: "failed", summary: String(err) });
      } finally {
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

import * as fs from "fs";

function extractBugScreenshots(runId: string, bugs: any[]): void {
  const dir = path.join(SCREENSHOTS_DIR, runId);
  let dirCreated = false;

  for (const bug of bugs) {
    if (!bug.screenshotBase64) continue;

    try {
      if (!dirCreated) {
        fs.mkdirSync(dir, { recursive: true });
        dirCreated = true;
      }
      const filename = `bug-${bug.index ?? 0}.jpg`;
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, Buffer.from(bug.screenshotBase64, "base64"));
      bug.screenshotBase64 = `/api/bugs/${runId}/${filename}`;
    } catch {
      // Keep original base64 if write fails
    }
  }
}
