/**
 * Run Orchestrator — multi-agent orchestration for test runs.
 * Accepts StorageAdapter for all database operations.
 */
import { chromium, type Page, type BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { runAgent, handleAuth, type RunStep, type LLMCallRecord, type LLMAgentType } from "./agent.js";
import { waitForPageStable } from "./agent.js";
import type { AuthConfig } from "./types.js";
import { createReviewProcessor, type ReviewRequest } from "./reviewAgent.js";
import { isStopRequested } from "./runEvents.js";
import { generateTestPlan, formatTestPlanForNavigator } from "./pathGenerator.js";
import { calcCostUsd } from "./llmClient.js";
import { summarizeRun, type SummarizeInput } from "./summarizer.js";
import type { ReviewBug } from "./types.js";
import { executeRegressionPlan, generateRegressionPlan, updatePlanConfidence, type RegressionStep } from "./regressionEngine.js";
import {
  loadProjectMemory, loadPageMemory,
  saveProjectMemoryEntries, savePageMemoryEntries,
  proposeMemoriesFromRun,
  type MemoryEntry,
} from "./agentMemory.js";
import { initStagehandSession, destroyStagehandSession, type StagehandSession } from "./stagehandBridge.js";
import type { StorageAdapter } from "./storage.js";
import { rewriteForDocker } from "./dockerHost.js";

export type RunJob = {
  runId?: string;
  baseUrl: string;
  intent: string;
  projectId?: string;
  auth?: AuthConfig | null;
  testId?: string;
  destinationId?: string;
  context?: string;
  saveScreenshots?: boolean;
  maxSteps?: number;
  recordVideo?: boolean;
  videosDir?: string;
  onStep?: (step: RunStep) => void;
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer) => void;
  onLLMCall?: (call: LLMCallRecord) => void;
};

export type RunResult = {
  status: "passed" | "failed" | "partial";
  steps: string[];
  stepsDetail: RunStep[];
  memoryLoaded: MemoryEntry[];
  memoryProposed: number;
  bugsFound: RunStep[];
  llmCalls: LLMCallRecord[];
  videoUrl?: string;
  summary?: string;
  error?: string;
};

export async function runOrchestratedJob(storage: StorageAdapter, job: RunJob): Promise<RunResult> {
  const config = getConfig();
  job.baseUrl = rewriteForDocker(job.baseUrl);
  if (job.auth?.loginUrl) job.auth.loginUrl = rewriteForDocker(job.auth.loginUrl);

  logger.info({ intent: job.intent }, "Starting orchestrated run");

  let context = job.context ?? "";
  let targetUrl: string | undefined;
  const pathGenCalls: LLMCallRecord[] = [];

  // Path Generator
  if (job.destinationId && job.projectId) {
    try {
      const dest = await storage.getDestination(job.destinationId);
      if (dest) {
        targetUrl = buildTargetUrl(job.baseUrl, dest.normalized_route);
        const t0 = Date.now();
        const { plan, usage } = await generateTestPlan(storage, {
          projectId: job.projectId, destinationId: job.destinationId,
          destination: dest, intent: job.intent,
        });
        const durationMs = Date.now() - t0;
        const planContext = formatTestPlanForNavigator(plan);
        if (planContext) context = context ? `${context}\n\n${planContext}` : planContext;
        if (usage) {
          const model = config.reviewModel ?? "gemini-2.5-flash-lite";
          pathGenCalls.push({
            seq: 0, stepIndex: 0, model, hasVision: false, attempt: 1,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens, durationMs,
            costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens),
            query: "Generate test plan for destination", response: planContext, agent: "pathgen",
          });
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), destinationId: job.destinationId }, "Path generator failed");
    }
  }

  // Check for regression plan
  let regressionPlan: RegressionStep[] | null = null;
  let regressionSource: { table: string; id: string } | null = null;

  if (job.testId) {
    try {
      const test = await storage.getRegressionPlan("saved_tests", job.testId);
      if (test?.regression_plan && test.plan_success_count > 0 && test.plan_status === "ready") {
        regressionPlan = test.regression_plan;
        regressionSource = { table: "saved_tests", id: test.id };
      }
    } catch {}
  }

  if (!regressionPlan && job.destinationId) {
    try {
      const dest = await storage.getRegressionPlan("app_tree_destinations", job.destinationId);
      if (dest?.regression_plan && (dest.plan_success_count ?? 0) > 0 && dest.plan_status === "ready") {
        regressionPlan = dest.regression_plan;
        regressionSource = { table: "app_tree_destinations", id: dest.id };
      }
    } catch {}
  }

  // Load memory
  const projectMemory = job.projectId ? await loadProjectMemory(storage, job.projectId) : [];
  const pageMemory = job.destinationId ? await loadPageMemory(storage, job.destinationId) : [];
  const allMemory = [...pageMemory, ...projectMemory];

  // Launch browser
  let browser;
  let browserContext: BrowserContext | undefined;
  let shSession: StagehandSession | undefined;
  const collectedLLMCalls: LLMCallRecord[] = [];
  const origOnLLMCall = job.onLLMCall;
  job.onLLMCall = (call) => {
    collectedLLMCalls.push(call);
    origOnLLMCall?.(call);
  };

  const shouldRecord = job.recordVideo !== false;
  const videoTmpDir = shouldRecord ? fs.mkdtempSync(path.join(os.tmpdir(), "kery-video-")) : undefined;

  try {
    if (config.stagehandEnabled) {
      try {
        shSession = await initStagehandSession(
          videoTmpDir ? { recordVideo: { dir: videoTmpDir, size: { width: 1920, height: 1080 } } } : undefined,
        );
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, "Stagehand session init failed — falling back to plain Playwright");
        shSession = undefined;
      }
    }

    let page;
    let videoEnabled = !!videoTmpDir;
    if (shSession) {
      page = shSession.page;
    } else {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const contextOpts: any = { viewport: { width: 1920, height: 1080 } };
      if (videoTmpDir) {
        contextOpts.recordVideo = { dir: videoTmpDir, size: { width: 1920, height: 1080 } };
      }
      try {
        browserContext = await browser.newContext(contextOpts);
        page = await browserContext.newPage();
      } catch (err) {
        if (videoTmpDir && String(err).includes("ffmpeg")) {
          logger.warn("ffmpeg not available — disabling video recording");
          videoEnabled = false;
          delete contextOpts.recordVideo;
          browserContext = await browser.newContext(contextOpts);
          page = await browserContext.newPage();
        } else {
          throw err;
        }
      }
    }
    await page.setDefaultTimeout(10000);

    // Try regression replay
    if (regressionPlan && regressionPlan.length > 0) {
      try {
        if (job.auth) {
          const authed = await handleAuth(page, job.auth, context, job.baseUrl);
          if (!authed) regressionPlan = null;
        }
      } catch {
        regressionPlan = null;
      }
    }

    if (regressionPlan && regressionPlan.length > 0) {
      try {
        const regResult = await executeRegressionPlan(page, regressionPlan, shSession?.page);
        if (regResult.status !== "stale") {
          if (regressionSource) {
            const current = await storage.getRegressionPlan(regressionSource.table, regressionSource.id);
            const newCount = updatePlanConfidence(current?.plan_success_count ?? 0, regResult);
            await storage.updateRegressionPlan(regressionSource.table, regressionSource.id, {
              plan_success_count: newCount, plan_status: "ready",
            });
          }

          const stepsDetail: RunStep[] = regressionPlan.map((step, i) => ({
            index: i + 1, action: step.action, target: step.name, value: step.value,
            reasoning: step.purpose, url: step.url ?? page.url(),
            status: i < regResult.stepsCompleted ? "ok" as const : "skipped" as const,
            fromMemory: false, at: Date.now(),
            elementRef: step.role && step.name ? { role: step.role, name: step.name } : undefined,
          }));

          const bugsFound: RunStep[] = regResult.bugs.map((bug) => ({
            index: bug.step, action: "bug", reasoning: bug.description,
            status: "ok" as const, fromMemory: false, bugType: "functional" as const,
            severity: "medium" as const, source: "navigator" as const,
          }));

          if (shSession) await destroyStagehandSession(shSession).catch(() => {});
          else {
            await browserContext?.close();
            await browser?.close();
          }

          const videoUrl = await finalizeVideo(videoTmpDir, job.videosDir, job.runId);

          return {
            status: regResult.status === "passed" ? "passed" : "failed",
            steps: stepsDetail.map(s => `[${s.index}] ${s.action} \u2192 ${s.target ?? ""}`),
            stepsDetail, bugsFound, llmCalls: pathGenCalls,
            memoryLoaded: allMemory, memoryProposed: 0, videoUrl,
          };
        }

        if (regressionSource) {
          await storage.updateRegressionPlan(regressionSource.table, regressionSource.id, {
            plan_status: "stale", plan_success_count: 0,
          });
        }
      } catch {
        // Fall through to LLM exploration
      }
    }

    // Full LLM exploration
    const reviewCalls: LLMCallRecord[] = [];
    const reviewProcessor = createReviewProcessor({
      concurrency: 3,
      onLLMCall: (call) => reviewCalls.push({ ...call, seq: 0 }),
    });

    let lastStep: RunStep | null = null;
    let screenshotSeq = 0; // Sequential counter for review agent
    let previousUrl = "";
    const screenshotsByStep = new Map<number, string>(); // Keyed by agent step.index
    const screenshotsBySeq = new Map<number, string>();  // Keyed by screenshotSeq (for review bugs)
    let latestCleanScreenshot: string | undefined;

    // Cross-agent communication: track review bugs fed back to navigator
    let reviewBugsFedBack = 0;
    const reviewBugFeedback: string[] = []; // Bug descriptions fed to navigator context

    const agentResult = await runAgent(
      page, job.intent, job.baseUrl, job.auth ?? null, allMemory,
      context, job.saveScreenshots ?? false,
      (step) => {
        // Associate the latest screenshot with this step's index
        if (latestCleanScreenshot) {
          screenshotsByStep.set(step.index, latestCleanScreenshot);
        }
        lastStep = step;
        // Cross-agent feedback: check if review agent has found new bugs and attach to step metadata
        const completedBugs = reviewProcessor.getCompletedBugs();
        if (completedBugs.length > reviewBugsFedBack) {
          const newBugs = completedBugs.slice(reviewBugsFedBack);
          reviewBugsFedBack = completedBugs.length;
          for (const bug of newBugs) {
            reviewBugFeedback.push(bug.description);
          }
          logger.info({ newBugs: newBugs.length, totalFedBack: reviewBugsFedBack }, "Cross-agent: review bugs fed back to navigator context");
          // Attach review feedback to the step so downstream consumers can see it
          (step as any).reviewFeedback = newBugs.map(b => ({ type: b.type, severity: b.severity, description: b.description }));
        }
        job.onStep?.(step);
      },
      async (screenshot, cleanScreenshot) => {
        job.onScreenshot?.(screenshot, cleanScreenshot);
        const url = page.url();
        const title = await page.title().catch(() => "");
        screenshotSeq++;
        // Track latest clean screenshot for step-aligned keying in onStep
        if (cleanScreenshot.length > 0) {
          latestCleanScreenshot = cleanScreenshot.toString("base64");
          screenshotsBySeq.set(screenshotSeq, latestCleanScreenshot);
        }
        const req: ReviewRequest = {
          screenshot: cleanScreenshot, url, title, stepIndex: screenshotSeq,
          action: lastStep ? `${lastStep.action} ${lastStep.target ?? ""}`.trim() : "initial",
          actionResult: lastStep?.status ?? "ok", expectation: lastStep?.reasoning,
          previousUrl: previousUrl || undefined,
        };
        previousUrl = url;
        reviewProcessor.push(req);
      },
      job.onLLMCall, job.maxSteps, targetUrl, shSession,
      job.runId ? () => isStopRequested(job.runId!) : undefined,
    );

    const reviewBugs = await reviewProcessor.flush();
    const bugsFound = mergeBugs(agentResult.stepsDetail, reviewBugs, screenshotsByStep, screenshotsBySeq);
    const mergedCalls = mergeLLMCalls(pathGenCalls, agentResult.llmCalls, reviewCalls);

    // Save memory
    const proposed = proposeMemoriesFromRun(agentResult.stepsDetail, job.intent);
    if (job.projectId && proposed.length > 0) await saveProjectMemoryEntries(storage, job.projectId, proposed);
    if (job.destinationId && proposed.length > 0) await savePageMemoryEntries(storage, job.destinationId, proposed);

    // Finalize video before closing browser — explicit page.close() triggers video write
    if (shSession) {
      try {
        const shPage = shSession.page;
        // Explicitly save video before Stagehand cleanup destroys the temp dir
        if (videoTmpDir) {
          try {
            const video = (shPage as any).video?.();
            if (video) {
              const tmpPath = await video.path();
              if (tmpPath) {
                await (shPage as any).close();
                // video.saveAs must be called after page.close()
                const destPath = `${videoTmpDir}/${job.runId || "video"}.webm`;
                const fs = await import("fs");
                fs.mkdirSync(videoTmpDir, { recursive: true });
                fs.copyFileSync(tmpPath, destPath);
              }
            }
          } catch (videoErr) {
            logger.warn({ err: String(videoErr).slice(0, 200) }, "Stagehand video save failed");
          }
        }
        await destroyStagehandSession(shSession).catch((err) => {
          logger.warn({ err: String(err).slice(0, 200) }, "Stagehand destroy error (non-fatal)");
        });
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, "Stagehand cleanup error");
      }
    } else {
      await browserContext?.close();
      await browser?.close();
    }

    const videoUrl = await finalizeVideo(videoTmpDir, job.videosDir, job.runId);

    let finalStatus = agentResult.status;
    const okSteps = agentResult.stepsDetail.filter(s => s.status === "ok" && !["done", "auth", "bug"].includes(s.action));
    if (bugsFound.length > 0 && okSteps.length >= 3 && finalStatus === "failed") {
      finalStatus = "partial";
    }

    const runStartedAt = agentResult.stepsDetail[0]?.at;
    const runEndedAt = agentResult.stepsDetail[agentResult.stepsDetail.length - 1]?.at;
    const runDurationMs = runStartedAt && runEndedAt ? runEndedAt - runStartedAt : undefined;

    const summarizeInput: SummarizeInput = {
      intent: job.intent, status: finalStatus, baseUrl: job.baseUrl,
      stepsDetail: agentResult.stepsDetail, bugsFound, llmCalls: mergedCalls,
      memoryLoaded: allMemory, memoryProposed: proposed.length,
      videoUrl, durationMs: runDurationMs,
    };
    const summarizeResult = await summarizeRun(summarizeInput);

    if (summarizeResult.usage && summarizeResult.model) {
      mergedCalls.push({
        seq: mergedCalls.length + 1,
        stepIndex: 0,
        model: summarizeResult.model,
        hasVision: false,
        attempt: 1,
        inputTokens: summarizeResult.usage.inputTokens,
        outputTokens: summarizeResult.usage.outputTokens,
        totalTokens: summarizeResult.usage.totalTokens,
        durationMs: summarizeResult.durationMs ?? 0,
        costUsd: summarizeResult.costUsd ?? 0,
        query: "Summarize test run",
        response: summarizeResult.summary.slice(0, 2000),
        agent: "summary",
      });
    }

    return {
      status: finalStatus, steps: agentResult.steps, stepsDetail: agentResult.stepsDetail,
      memoryLoaded: allMemory, memoryProposed: proposed.length,
      bugsFound, llmCalls: mergedCalls, summary: summarizeResult.summary, videoUrl,
    };
  } catch (err) {
    logger.error({ err: String(err) }, "Run failed");
    if (shSession) await destroyStagehandSession(shSession).catch(() => {});
    else {
      await browserContext?.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
    cleanupVideoTmpDir(videoTmpDir);
    return {
      status: "failed", steps: [], stepsDetail: [], memoryLoaded: [], memoryProposed: 0,
      bugsFound: [], llmCalls: collectedLLMCalls, error: String(err),
    };
  }
}

function buildTargetUrl(baseUrl: string, normalizedRoute: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const route = normalizedRoute.startsWith("/") ? normalizedRoute : `/${normalizedRoute}`;
  return `${base}${route}`;
}

function mergeLLMCalls(pathGen: LLMCallRecord[], navigator: LLMCallRecord[], review: LLMCallRecord[]): LLMCallRecord[] {
  const merged: LLMCallRecord[] = [
    ...pathGen.map((c) => ({ ...c, agent: "pathgen" as LLMAgentType })),
    ...navigator.map((c) => ({ ...c, agent: (c.agent ?? "navigator") as LLMAgentType })),
    ...review.map((c) => ({ ...c, agent: "review" as LLMAgentType })),
  ];
  merged.forEach((c, i) => { c.seq = i + 1; });
  return merged;
}

function mergeBugs(
  stepsDetail: RunStep[], reviewBugs: ReviewBug[],
  screenshotsByStep?: Map<number, string>,
  screenshotsBySeq?: Map<number, string>,
): RunStep[] {
  const out: RunStep[] = [];
  for (const step of stepsDetail) {
    if (step.status === "failed" && step.action !== "bug") {
      out.push({
        index: step.index, action: "bug",
        reasoning: step.error ?? `Step failed: ${step.action} ${step.target ?? ""}`,
        url: step.url, status: "ok", fromMemory: false,
        bugType: "functional", severity: "medium", source: "navigator", at: step.at,
        screenshotBase64: screenshotsByStep?.get(step.index ?? 0),
      });
    }
  }
  for (const b of reviewBugs) {
    const bugType = b.type === "behavioral" ? "functional" : b.type;
    out.push({
      index: b.stepIndex, action: "bug", reasoning: b.description,
      status: "ok", fromMemory: false, bugType, severity: b.severity,
      source: "review", at: b.at,
      // Review bugs use screenshotSeq index, navigator bugs use step.index
      screenshotBase64: screenshotsBySeq?.get(b.stepIndex),
    });
  }
  out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return out;
}

// ─── Video helpers ──────────────────────────────────────────────────────────

async function finalizeVideo(
  tmpDir: string | undefined,
  videosDir: string | undefined,
  runId: string | undefined,
): Promise<string | undefined> {
  if (!tmpDir || !runId) return undefined;
  try {
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".webm"));
    if (files.length === 0) {
      logger.warn({ tmpDir, allFiles: fs.readdirSync(tmpDir) }, "No .webm video files found in temp dir");
      return undefined;
    }

    const srcPath = path.join(tmpDir, files[0]);
    const destDir = videosDir || path.join(process.cwd(), "data", "videos");
    fs.mkdirSync(destDir, { recursive: true });

    const destFile = `${runId}.webm`;
    const destPath = path.join(destDir, destFile);
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);

    cleanupVideoTmpDir(tmpDir);
    logger.info({ runId, path: destPath }, "Video recording saved");
    return `/api/runs/${runId}/video`;
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to finalize video recording");
    cleanupVideoTmpDir(tmpDir);
    return undefined;
  }
}

function cleanupVideoTmpDir(tmpDir: string | undefined): void {
  if (!tmpDir) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
