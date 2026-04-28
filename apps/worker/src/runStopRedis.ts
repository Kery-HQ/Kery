import type { Redis } from "ioredis";

const PREFIX = "kery:run:stop:";

export function runStopRedisKey(runId: string): string {
  return `${PREFIX}${runId}`;
}

export async function clearRunStopRequest(redis: Redis, runId: string): Promise<void> {
  await redis.del(runStopRedisKey(runId));
}

/**
 * Poll Redis so `shouldStop()` stays synchronous for the engine while still reacting to API stop.
 */
export function startRunStopPoller(redis: Redis, runId: string): { shouldStop: () => boolean; dispose: () => void } {
  let flag = false;
  const key = runStopRedisKey(runId);

  const tick = async () => {
    try {
      const v = await redis.get(key);
      flag = v === "1";
    } catch {
      /* ignore transient Redis errors */
    }
  };

  void tick();
  const id = setInterval(() => void tick(), 100);

  return {
    shouldStop: () => flag,
    dispose: () => {
      clearInterval(id);
    },
  };
}
