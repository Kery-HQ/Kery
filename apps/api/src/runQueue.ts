import { Queue } from "bullmq";

/** BullMQ forbids ':' in queue names (reserved for Redis Cluster key tags). */
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
