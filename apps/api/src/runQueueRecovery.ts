import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { logger, serializeError } from "@kery/engine";
import { RUN_QUEUE_NAME, type RunJobData } from "./runQueue.js";

const ACTIVE_JOB_STALE_MS = 90_000;
const LIVE_QUEUE_STATES = new Set(["waiting", "delayed", "prioritized", "paused", "waiting-children"]);
const RECOVERABLE_JOB_STATES = ["waiting", "delayed", "prioritized", "paused", "active"] as const;

type DbRun = Record<string, any> & { id: string; status: string };

async function failQueuedRun(
  storage: StorageAdapter,
  run: DbRun,
  summary: string,
  logContext: Record<string, unknown>,
): Promise<DbRun> {
  await storage.updateTestRun(run.id, {
    status: "failed",
    summary,
    completed_at: new Date().toISOString(),
  });
  logger.warn({ ...logContext, runId: run.id, summary }, "Queued run marked failed");
  return (await storage.getTestRun(run.id)) ?? { ...run, status: "failed", summary };
}

async function removeOrphanedJob(job: Job<RunJobData>, logContext: Record<string, unknown>): Promise<boolean> {
  try {
    await job.remove();
    logger.warn({ ...logContext, jobId: job.id }, "Removed orphaned BullMQ job");
    return true;
  } catch (err) {
    logger.warn({ ...logContext, jobId: job.id, err: serializeError(err) }, "Could not remove orphaned BullMQ job");
    return false;
  }
}

async function findQueueJobForRun(
  runQueue: Queue<RunJobData>,
  runId: string,
): Promise<Job<RunJobData> | undefined> {
  const direct = await runQueue.getJob(runId);
  if (direct) return direct;

  const jobs = await runQueue.getJobs([...RECOVERABLE_JOB_STATES], 0, 5000);
  return jobs.find((job) => job.data?.runId === runId);
}

export async function reconcileQueuedRun(
  storage: StorageAdapter,
  runQueue: Queue<RunJobData>,
  redis: Redis,
  run: DbRun,
  reason: string,
): Promise<DbRun> {
  if (!run || run.status !== "queued") return run;

  const runId = run.id;
  const logContext = { runId, queue: RUN_QUEUE_NAME, reason };

  try {
    const job = await findQueueJobForRun(runQueue, runId);
    if (!job) {
      return await failQueuedRun(storage, run, "Job lost — no queue job found", logContext);
    }

    const state = await job.getState();
    if (LIVE_QUEUE_STATES.has(state)) return run;

    if (state === "failed") {
      return await failQueuedRun(
        storage,
        run,
        job.failedReason?.trim() || "Queue job failed before run started",
        { ...logContext, jobId: job.id, state },
      );
    }

    if (state === "completed") {
      return await failQueuedRun(
        storage,
        run,
        "Queue job completed without updating run state",
        { ...logContext, jobId: job.id, state },
      );
    }

    if (state === "active") {
      const jobId = String(job.id ?? runId);
      const lockKey = runQueue.toKey(jobId) + ":lock";
      const lockTtl = await redis.pttl(lockKey).catch(() => null);
      const processedOn = typeof job.processedOn === "number" ? job.processedOn : null;
      const activeAgeMs = processedOn ? Date.now() - processedOn : null;
      const hasLiveLock = typeof lockTtl === "number" && lockTtl > 0;
      const isStale = activeAgeMs === null || activeAgeMs > ACTIVE_JOB_STALE_MS;

      if (!hasLiveLock && isStale) {
        const removed = await removeOrphanedJob(job, {
          ...logContext,
          jobId: job.id,
          state,
          lockTtl,
          activeAgeMs,
        });
        if (removed) {
          return await failQueuedRun(
            storage,
            run,
            "Job lost — active queue job has no worker lock",
            { ...logContext, jobId: job.id, state, lockTtl, activeAgeMs },
          );
        }
      }

      logger.info({ ...logContext, jobId: job.id, state, lockTtl, activeAgeMs }, "Queued run still has active BullMQ job");
      return run;
    }

    return await failQueuedRun(
      storage,
      run,
      `Queue job is in unexpected state: ${state}`,
      { ...logContext, jobId: job.id, state },
    );
  } catch (err) {
    logger.warn({ ...logContext, err: serializeError(err) }, "Queued run reconciliation failed");
    return run;
  }
}

export async function reconcileQueuedRunsForProject(
  storage: StorageAdapter,
  runQueue: Queue<RunJobData>,
  redis: Redis,
  projectId: string,
  reason: string,
  limit = 100,
): Promise<void> {
  const pool = storage.getPool() as Pool;
  const { rows } = await pool.query<DbRun>(
    `SELECT * FROM test_runs
      WHERE project_id = $1 AND status = 'queued'
      ORDER BY started_at ASC
      LIMIT $2`,
    [projectId, limit],
  );
  for (const run of rows) {
    await reconcileQueuedRun(storage, runQueue, redis, run, reason);
  }
}

export async function recoverInterruptedRuns(
  storage: StorageAdapter,
  runQueue: Queue<RunJobData>,
  redis: Redis,
): Promise<void> {
  const pool = storage.getPool() as Pool;
  await pool.query(
    `UPDATE test_runs
       SET status = 'failed', summary = 'Interrupted — server restarted', completed_at = now()
     WHERE status = 'running'`,
  ).then(({ rowCount }) => {
    if (rowCount && rowCount > 0) console.log(`Recovered ${rowCount} zombie run(s) from previous crash`);
  }).catch((err) => {
    logger.warn({ err: serializeError(err) }, "Failed to recover running runs");
  });

  try {
    const { rows } = await pool.query<DbRun>(
      `SELECT * FROM test_runs WHERE status = 'queued' ORDER BY started_at ASC LIMIT 5000`,
    );
    for (const run of rows) {
      await reconcileQueuedRun(storage, runQueue, redis, run, "api-startup");
    }
  } catch (err) {
    logger.warn({ err: serializeError(err) }, "Failed to reconcile queued runs with BullMQ");
  }
}
