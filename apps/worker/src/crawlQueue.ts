import { Queue, Worker, Job } from "bullmq";
import type { StorageAdapter } from "@kery/engine";
import { executeCrawlRun, logger } from "@kery/engine";

export const CRAWL_QUEUE_NAME = "kery-crawls";

export interface CrawlJobData {
  projectId: string;
  environmentId: string;
  triggerType: "manual" | "webhook" | "scheduled";
}

export function createCrawlQueue(redisUrl: string) {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
  };
  const queue = new Queue<CrawlJobData>(CRAWL_QUEUE_NAME, { connection });
  return { queue, connection };
}

export function createCrawlWorker(
  connection: { host: string; port: number; password?: string },
  storage: StorageAdapter,
) {
  const worker = new Worker<CrawlJobData>(
    CRAWL_QUEUE_NAME,
    async (job: Job<CrawlJobData>) => {
      const { projectId, environmentId, triggerType } = job.data;
      logger.info({ projectId, environmentId }, "Crawl job started");
      try {
        const { result } = await executeCrawlRun(storage, projectId, environmentId, triggerType);
        logger.info({ projectId, destinations: result.destinationsBuilt }, "Crawl job complete");
      } catch (err) {
        logger.error({ err: String(err), projectId }, "Crawl job failed");
        throw err;
      }
    },
    {
      connection,
      concurrency: 1,
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, projectId: job?.data?.projectId, err: String(err) }, "Crawl BullMQ job failed");
  });

  return worker;
}
