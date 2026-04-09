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
  parseLiveRunSnapshot,
  type LiveRunSnapshot,
  type LiveRunReduceEvent,
} from "@kery/engine";
import { logger } from "@kery/engine";

const DEFAULT_TTL_SEC = 172_800; // 48h safety net
const DEFAULT_PREVIEW_MIN_MS = 750;

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

export type RunLiveBridge = {
  forwardStep: (step: unknown) => Promise<void>;
  forwardAgentPlan: (items: AgentPlanItem[]) => Promise<void>;
  forwardActivity: (activity: { kind: "observe"; text: string; at: number }) => Promise<void>;
  forwardLlmCall: (call: unknown) => Promise<void>;
  /** SSE fires every frame; disk + Redis `live_preview` are throttled inside. */
  forwardScreenshot: (buf: Buffer) => Promise<void>;
  /** Merge-only updates (metrics, flags) without touching steps/plan/LLM lists. */
  patchObservability: (patch: Record<string, unknown>) => Promise<void>;
};

/**
 * Keeps SSE and Redis/disk live preview in sync. All live-preview observability should go
 * through this object so Redis stays aligned with what the UI streams.
 */
export function createRunLiveBridge(options: {
  redis: Redis;
  runId: string;
  screenshotsDir: string;
  emitter: EventEmitter;
  ttlSeconds?: number;
  minPreviewIntervalMs?: number;
}): RunLiveBridge {
  const { redis, runId, screenshotsDir, emitter } = options;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SEC;
  const minPreviewMs = options.minPreviewIntervalMs ?? DEFAULT_PREVIEW_MIN_MS;
  const key = liveRunRedisKey(runId);

  let snapshot = emptyLiveRunSnapshot();
  let lastPreviewWriteMs = 0;

  /** Orchestrator does not await callbacks; serialize Redis/snapshot updates so events never clobber each other. */
  let persistChain: Promise<void> = Promise.resolve();
  function enqueuePersist(task: () => Promise<void>): Promise<void> {
    const run = persistChain.then(task, task);
    persistChain = run.catch((err) => {
      logger.warn({ runId, err: String(err) }, "Live run: persist chain task failed");
    });
    return run;
  }

  async function persist(event: LiveRunReduceEvent): Promise<void> {
    snapshot = applyLiveRunEvent(snapshot, event);
    try {
      await redis.set(key, JSON.stringify(snapshot), "EX", ttl);
    } catch (err) {
      logger.warn({ runId, err: String(err) }, "Live run: Redis set failed");
    }
  }

  return {
    forwardStep(step) {
      return enqueuePersist(async () => {
        await persist({ type: "step", step });
        emitter.emit("step", step);
      });
    },

    forwardAgentPlan(items) {
      const at = Date.now();
      return enqueuePersist(async () => {
        await persist({ type: "plan", items, at });
        emitter.emit("plan", { items, at });
      });
    },

    forwardActivity(activity) {
      return enqueuePersist(async () => {
        await persist({ type: "activity", activity });
        emitter.emit("activity", activity);
      });
    },

    forwardLlmCall(call) {
      return enqueuePersist(async () => {
        await persist({ type: "llm_call", call });
        emitter.emit("llm_call", call);
      });
    },

    forwardScreenshot(buf) {
      const b64 = buf.toString("base64");
      emitter.emit("screenshot", b64);

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

        await persist({
          type: "live_preview",
          filename: LIVE_PREVIEW_FILENAME,
          at: now,
        });
      });
    },

    patchObservability(patch) {
      return enqueuePersist(async () => {
        await persist({ type: "observability_patch", patch });
      });
    },
  };
}
