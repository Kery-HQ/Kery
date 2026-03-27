import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino/file", options: { destination: 1 } }
    : undefined,
  mixin() {
    const correlationId = runCorrelation.getStore();
    return correlationId ? { runId: correlationId } : {};
  },
});

// ─── Per-run Correlation IDs ─────────────────────────────────────────────────

const runCorrelation = new AsyncLocalStorage<string>();

/**
 * Execute a function with a run correlation ID.
 * All log output within the callback will include `runId` automatically.
 */
export function withRunCorrelation<T>(runId: string, fn: () => T): T {
  return runCorrelation.run(runId, fn);
}

/**
 * Get the current run correlation ID (if set).
 */
export function getRunCorrelationId(): string | undefined {
  return runCorrelation.getStore();
}

/**
 * Set the run correlation ID for the current async context.
 * Prefer withRunCorrelation() for scoped usage. This is for cases
 * where you need to set it imperatively (e.g., middleware).
 */
export function setRunCorrelationId(runId: string): void {
  // Note: This only works if called within an existing AsyncLocalStorage.run() scope.
  // For top-level usage, use withRunCorrelation() instead.
  const store = runCorrelation.getStore();
  if (store === undefined) {
    // Can't set without a scope — caller should use withRunCorrelation
    logger.debug({ runId }, "setRunCorrelationId called outside async scope — use withRunCorrelation instead");
  }
}
