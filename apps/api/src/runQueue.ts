import { Queue } from "bullmq";

/** BullMQ forbids ':' in queue names (reserved for Redis Cluster key tags). */
export const RUN_QUEUE_NAME = "kery-runs";
export const CRAWL_QUEUE_NAME = "kery-crawls";

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

export interface CrawlJobData {
  projectId: string;
  environmentId: string;
  triggerType: "manual" | "webhook" | "scheduled";
}

function parseRedisUrl(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
  };
}

export function createRunQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);
  const queue = new Queue(RUN_QUEUE_NAME, { connection });
  return { queue, connection };
}

export function createCrawlQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);
  const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_NAME, { connection });
  return { queue, connection };
}
