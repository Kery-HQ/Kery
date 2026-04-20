import * as fs from "fs";
import * as path from "path";
import type { Redis } from "ioredis";
import {
  LIVE_PREVIEW_FILENAME,
  liveRunRedisKey,
  parseLiveRunSnapshot,
  type LiveRunSnapshot,
} from "@kery/engine";
import { logger } from "@kery/engine";

export const RUN_EVENTS_CHANNEL_PREFIX = "kery:run:events:";

export function runEventsChannel(runId: string): string {
  return `${RUN_EVENTS_CHANNEL_PREFIX}${runId}`;
}

export async function readLiveRunSnapshotFromRedis(redis: Redis, runId: string): Promise<LiveRunSnapshot | null> {
  const raw = await redis.get(liveRunRedisKey(runId));
  return parseLiveRunSnapshot(raw);
}

export async function deleteLiveRunState(redis: Redis, runId: string, screenshotsDir: string): Promise<void> {
  try {
    await redis.del(liveRunRedisKey(runId));
  } catch (err) {
    logger.warn({ runId, err: String(err) }, "Live run: Redis delete failed");
  }
  const preview = path.join(screenshotsDir, runId, LIVE_PREVIEW_FILENAME);
  try {
    if (fs.existsSync(preview)) fs.unlinkSync(preview);
  } catch (err) {
    logger.warn({ runId, err: String(err) }, "Live run: preview file delete failed");
  }
}

/** Merge DB row with Redis snapshot for `GET /api/runs/:id` while status is running. */
export function mergeDbRunWithLiveSnapshot(dbRun: Record<string, unknown>, live: LiveRunSnapshot): Record<string, unknown> {
  return {
    ...dbRun,
    steps_json: live.steps.length > 0 ? live.steps : dbRun.steps_json,
    llm_calls_json: live.llmCalls.length > 0 ? live.llmCalls : dbRun.llm_calls_json,
    live_snapshot: {
      agentPlan: live.agentPlan,
      activity: live.activity,
      livePreview: live.livePreview,
      observability: live.observability,
    },
  };
}
