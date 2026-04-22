import * as fs from "fs";
import * as path from "path";
import type { EventEmitter } from "events";
import type { Redis } from "ioredis";
import type { AgentPlanItem } from "@kery/engine";
import {
  LIVE_PREVIEW_FILENAME,
  liveRunRedisKey,
  emptyLiveRunSnapshot,
  applyLiveRunEvent,
  type LiveRunSnapshot,
  type LiveRunReduceEvent,
} from "@kery/engine";
import { logger } from "@kery/engine";

export const RUN_EVENTS_CHANNEL_PREFIX = "kery:run:events:";

export function runEventsChannel(runId: string): string {
  return `${RUN_EVENTS_CHANNEL_PREFIX}${runId}`;
}

const DEFAULT_TTL_SEC = 172_800; // 48h safety net
const DEFAULT_PREVIEW_MIN_MS = 750;

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

export type RunLiveBridge = {
  forwardStep: (step: unknown) => Promise<void>;
  forwardAgentPlan: (items: AgentPlanItem[]) => Promise<void>;
  forwardActivity: (activity: { kind: "observe"; text: string; at: number }) => Promise<void>;
  forwardLlmCall: (call: unknown) => Promise<void>;
  forwardReplayProgress: (stepIndex: number | null, planIndex: number | null, at?: number) => Promise<void>;
  forwardScreenshot: (buf: Buffer) => Promise<void>;
  patchObservability: (patch: Record<string, unknown>) => Promise<void>;
  /** Publish the final "done" event so SSE clients in the API process terminate cleanly. */
  publishDone: (run: unknown) => Promise<void>;
};

/**
 * Keeps Redis live snapshot in sync and publishes events to a Redis Pub/Sub channel
 * so the API process can forward them to SSE clients without sharing memory.
 */
export function createRunLiveBridge(options: {
  redis: Redis;
  redisPub: Redis;
  runId: string;
  screenshotsDir: string;
  ttlSeconds?: number;
  minPreviewIntervalMs?: number;
}): RunLiveBridge {
  const { redis, redisPub, runId, screenshotsDir } = options;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SEC;
  const minPreviewMs = options.minPreviewIntervalMs ?? DEFAULT_PREVIEW_MIN_MS;
  const snapshotKey = liveRunRedisKey(runId);
  const channel = runEventsChannel(runId);

  let snapshot: LiveRunSnapshot = emptyLiveRunSnapshot();
  let lastPreviewWriteMs = 0;

  let persistChain: Promise<void> = Promise.resolve();
  function enqueuePersist(task: () => Promise<void>): Promise<void> {
    const run = persistChain.then(task, task);
    persistChain = run.catch((err) => {
      logger.warn({ runId, err: String(err) }, "Live run: persist chain task failed");
    });
    return run;
  }

  async function persistSnapshot(event: LiveRunReduceEvent): Promise<void> {
    snapshot = applyLiveRunEvent(snapshot, event);
    try {
      await redis.set(snapshotKey, JSON.stringify(snapshot), "EX", ttl);
    } catch (err) {
      logger.warn({ runId, err: String(err) }, "Live run: Redis set failed");
    }
  }

  async function publish(payload: object): Promise<void> {
    try {
      await redisPub.publish(channel, JSON.stringify(payload));
    } catch (err) {
      logger.warn({ runId, err: String(err) }, "Live run: Redis publish failed");
    }
  }

  return {
    forwardStep(step) {
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "step", step });
        await publish({ type: "step", step });
      });
    },

    forwardAgentPlan(items) {
      const at = Date.now();
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "plan", items, at });
        await publish({ type: "plan", items, at });
      });
    },

    forwardActivity(activity) {
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "activity", activity });
        await publish({ type: "activity", activity });
      });
    },

    forwardLlmCall(call) {
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "llm_call", call });
        await publish({ type: "llm_call", call });
      });
    },

    forwardReplayProgress(stepIndex, planIndex, at = Date.now()) {
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "replay_progress", stepIndex, planIndex, at });
        await publish({ type: "replay_progress", stepIndex, planIndex, at });
      });
    },

    forwardScreenshot(buf) {
      const b64 = buf.toString("base64");
      // Publish screenshot immediately (no throttle — SSE clients need it live)
      void publish({ type: "screenshot", data: b64 });

      const now = Date.now();
      if (now - lastPreviewWriteMs < minPreviewMs) return Promise.resolve();
      lastPreviewWriteMs = now;

      return enqueuePersist(async () => {
        try {
          const dir = path.join(screenshotsDir, runId);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, LIVE_PREVIEW_FILENAME), buf);
        } catch (err) {
          logger.warn({ runId, err: String(err) }, "Live run: preview write failed");
          return;
        }
        await persistSnapshot({
          type: "live_preview",
          filename: LIVE_PREVIEW_FILENAME,
          at: now,
        });
      });
    },

    patchObservability(patch) {
      return enqueuePersist(async () => {
        await persistSnapshot({ type: "observability_patch", patch });
      });
    },

    publishDone(run) {
      return publish({ type: "done", run });
    },
  };
}
