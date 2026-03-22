/**
 * Run Orchestrator — multi-agent orchestration for test runs.
 *
 * OSS version: always uses local Playwright (no BrowserStack).
 * Accepts StorageAdapter for all database operations.
 */
import { chromium, type Page } from "playwright";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { runAgent, handleAuth, type RunStep, type LLMCallRecord, type LLMAgentType } from "./agent.js";
import { waitForPageStable } from "./agent.js";
import type { AuthConfig } from "./types.js";
import { createReviewProcessor, type ReviewRequest } from "./reviewAgent.js";
import { generateTestPlan, formatTestPlanForNavigator } from "./pathGenerator.js";
import { calcCostUsd } from "./llmClient.js";
import { summarizeRun } from "./summarizer.js";
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

export type RunJob = {
  baseUrl: string;
  intent: string;
  projectId?: string;
  auth?: AuthConfig | null;
  testId?: string;
  destinationId?: string;
  context?: string;
  saveScreenshots?: boolean;
  maxSteps?: number;
  onStep?: (step: RunStep) => void;
  onScreenshot?: (screenshot: Buffer) => void;
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
  let shSession: StagehandSession | undefined;

  try {
    if (config.stagehandEnabled) {
      try {
        shSession = await initStagehandSession();
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, "Stagehand session init failed — falling back to plain Playwright");
        shSession = undefined;
      }
    }

    let page;
    if (shSession) {
      page = shSession.page;
    } else {
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    }
    await page.setDefaultTimeout(10000);

    // Try regression replay
    if (regressionPlan && regressionPlan.length > 0) {
      try {
        if (job.auth) {
          const authed = await handleAuth(page, job.auth, context);
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
          else await browser?.close();

          return {
            status: regResult.status === "passed" ? "passed" : "failed",
            steps: stepsDetail.map(s => `[${s.index}] ${s.action} \u2192 ${s.target ?? ""}`),
            stepsDetail, bugsFound, llmCalls: pathGenCalls,
            memoryLoaded: allMemory, memoryProposed: 0,
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
    let screenshotStepIndex = 0;
    let previousUrl = "";

    const agentResult = await runAgent(
      page, job.intent, job.baseUrl, job.auth ?? null, allMemory,
      context, job.saveScreenshots ?? false,
      (step) => { lastStep = step; job.onStep?.(step); },
      async (screenshot) => {
        job.onScreenshot?.(screenshot);
        const url = page.url();
        const title = await page.title().catch(() => "");
        screenshotStepIndex++;
        const req: ReviewRequest = {
          screenshot, url, title, stepIndex: screenshotStepIndex,
          action: lastStep ? `${lastStep.action} ${lastStep.target ?? ""}`.trim() : "initial",
          actionResult: lastStep?.status ?? "ok", expectation: lastStep?.reasoning,
          previousUrl: previousUrl || undefined,
        };
        previousUrl = url;
        reviewProcessor.push(req);
      },
      job.onLLMCall, job.maxSteps, targetUrl, shSession,
    );

    const reviewBugs = await reviewProcessor.flush();
    const bugsFound = mergeBugs(agentResult.stepsDetail, reviewBugs);
    const mergedCalls = mergeLLMCalls(pathGenCalls, agentResult.llmCalls, reviewCalls);

    // Save memory
    const proposed = proposeMemoriesFromRun(agentResult.stepsDetail, job.intent);
    if (job.projectId && proposed.length > 0) await saveProjectMemoryEntries(storage, job.projectId, proposed);
    if (job.destinationId && proposed.length > 0) await savePageMemoryEntries(storage, job.destinationId, proposed);

    if (shSession) await destroyStagehandSession(shSession).catch(() => {});
    else await browser?.close();

    let finalStatus = agentResult.status;
    const okSteps = agentResult.stepsDetail.filter(s => s.status === "ok" && !["done", "auth", "bug"].includes(s.action));
    if (bugsFound.length > 0 && okSteps.length >= 3 && finalStatus === "failed") {
      finalStatus = "partial";
    }

    const summary = await summarizeRun(job.intent, finalStatus, agentResult.steps);

    return {
      status: finalStatus, steps: agentResult.steps, stepsDetail: agentResult.stepsDetail,
      memoryLoaded: allMemory, memoryProposed: proposed.length,
      bugsFound, llmCalls: mergedCalls, summary,
    };
  } catch (err) {
    logger.error({ err: String(err) }, "Run failed");
    if (shSession) await destroyStagehandSession(shSession).catch(() => {});
    else if (browser) await browser.close().catch(() => {});
    return {
      status: "failed", steps: [], stepsDetail: [], memoryLoaded: [], memoryProposed: 0,
      bugsFound: [], llmCalls: [], error: String(err),
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

function mergeBugs(stepsDetail: RunStep[], reviewBugs: ReviewBug[]): RunStep[] {
  const out: RunStep[] = [];
  for (const step of stepsDetail) {
    if (step.status === "failed" && step.action !== "bug") {
      out.push({
        index: step.index, action: "bug",
        reasoning: step.error ?? `Step failed: ${step.action} ${step.target ?? ""}`,
        url: step.url, status: "ok", fromMemory: false,
        bugType: "functional", severity: "medium", source: "navigator", at: step.at,
      });
    }
  }
  for (const b of reviewBugs) {
    const bugType = b.type === "behavioral" ? "functional" : b.type;
    out.push({
      index: b.stepIndex, action: "bug", reasoning: b.description,
      status: "ok", fromMemory: false, bugType, severity: b.severity,
      source: "review", at: b.at,
    });
  }
  out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return out;
}
