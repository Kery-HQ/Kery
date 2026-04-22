import type { AgentPlanItem } from "./agent.js";

/**
 * Single timeline shape used by Run Detail “live action” / plan. Keep in sync with
 * `ActivityEntry` on the web app (same discriminated `type` + payloads).
 */
export type LiveActivityEntry =
  | { type: "step"; at: number; step: unknown }
  | { type: "plan"; at: number; items: AgentPlanItem[] }
  | { type: "activity"; at: number; activity: { kind: "observe"; text: string; at: number } };

/**
 * Transient run state persisted to Redis while a job is active (refresh / reconnect).
 *
 * When adding observability for live preview:
 * 1. Extend this interface (or merge into `observability` for experiments).
 * 2. Add a branch in `applyLiveRunEvent` below.
 * 3. Hydrate the same fields in Run Detail from `GET /api/runs/:id` (`live_snapshot`).
 */
export interface LiveRunSnapshot {
  schemaVersion: 1;
  steps: unknown[];
  llmCalls: unknown[];
  agentPlan: { items: AgentPlanItem[]; at: number } | null;
  replayProgress: { stepIndex: number | null; planIndex: number | null; at: number } | null;
  activity: LiveActivityEntry[];
  /** Latest throttled live preview frame on disk (under SCREENSHOTS_DIR/<runId>/). */
  livePreview: { filename: string; updatedAt: number } | null;
  /**
   * Optional bag for extra metrics / flags without a migration. Prefer top-level fields
   * when the UI needs typed support.
   */
  observability?: Record<string, unknown>;
}

export const LIVE_PREVIEW_FILENAME = "live-preview.jpg";

/** Redis key; TTL refreshed on each write. Deleted when the run job finishes. */
export function liveRunRedisKey(runId: string): string {
  return `kery:run:live:${runId}`;
}

export function emptyLiveRunSnapshot(): LiveRunSnapshot {
  return {
    schemaVersion: 1,
    steps: [],
    llmCalls: [],
    agentPlan: null,
    replayProgress: null,
    activity: [],
    livePreview: null,
  };
}

/** Events that mutate `LiveRunSnapshot` — wire new live-preview signals here. */
export type LiveRunReduceEvent =
  | { type: "step"; step: unknown }
  | { type: "plan"; items: AgentPlanItem[]; at: number }
  | { type: "activity"; activity: { kind: "observe"; text: string; at: number } }
  | { type: "llm_call"; call: unknown }
  | { type: "replay_progress"; stepIndex: number | null; planIndex: number | null; at: number }
  | { type: "live_preview"; filename: string; at: number }
  | { type: "observability_patch"; patch: Record<string, unknown> };

export function applyLiveRunEvent(state: LiveRunSnapshot, event: LiveRunReduceEvent): LiveRunSnapshot {
  switch (event.type) {
    case "step": {
      const steps = [...state.steps, event.step];
      const stepAt =
        typeof (event.step as { at?: number })?.at === "number"
          ? (event.step as { at: number }).at
          : Date.now();
      const activity: LiveActivityEntry[] = [
        ...state.activity,
        { type: "step", at: stepAt, step: event.step },
      ];
      return { ...state, steps, activity };
    }
    case "plan": {
      const agentPlan = { items: event.items, at: event.at };
      const activity: LiveActivityEntry[] = [
        ...state.activity,
        { type: "plan", at: event.at, items: event.items },
      ];
      return { ...state, agentPlan, activity };
    }
    case "activity": {
      const at = event.activity.at ?? Date.now();
      const activity: LiveActivityEntry[] = [
        ...state.activity,
        { type: "activity", at, activity: event.activity },
      ];
      return { ...state, activity };
    }
    case "llm_call": {
      return { ...state, llmCalls: [...state.llmCalls, event.call] };
    }
    case "replay_progress": {
      return {
        ...state,
        replayProgress: { stepIndex: event.stepIndex, planIndex: event.planIndex, at: event.at },
      };
    }
    case "live_preview": {
      return {
        ...state,
        livePreview: { filename: event.filename, updatedAt: event.at },
      };
    }
    case "observability_patch": {
      return {
        ...state,
        observability: { ...state.observability, ...event.patch },
      };
    }
  }
}

export function parseLiveRunSnapshot(raw: string | null | undefined): LiveRunSnapshot | null {
  if (raw == null || raw === "") return null;
  try {
    const v = JSON.parse(raw) as Partial<LiveRunSnapshot>;
    if (v.schemaVersion !== 1 || !Array.isArray(v.steps) || !Array.isArray(v.llmCalls) || !Array.isArray(v.activity)) {
      return null;
    }
    return {
      schemaVersion: 1,
      steps: v.steps,
      llmCalls: v.llmCalls,
      agentPlan: v.agentPlan ?? null,
      replayProgress: v.replayProgress ?? null,
      activity: v.activity as LiveActivityEntry[],
      livePreview: v.livePreview ?? null,
      observability: v.observability && typeof v.observability === "object" ? v.observability : undefined,
    };
  } catch {
    return null;
  }
}
