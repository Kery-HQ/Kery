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
import { runAgent, handleAuth, type RunStep, type LLMCallRecord, type LLMAgentType, type AgentPlanItem } from "./agent.js";
import { waitForPageStable } from "./agent.js";
import type { AuthConfig } from "./types.js";
import { runFilmstripReview, type FilmstripFrame } from "./filmstripReview.js";
import { runHolisticFlowReview } from "./holisticReviewAgent.js";
import { isStopRequested } from "./runEvents.js";
import type { ReviewBug } from "./types.js";
import { executeRegressionPlan, updatePlanConfidence, type RegressionStep } from "./regressionEngine.js";
import { generateScriptWithLLM } from "./scriptGenerator.js";
import {
  loadProjectMemoryWithDecay, loadPageMemoryWithDecay,
  boostConfidence,
  type MemoryEntry,
} from "./agentMemory.js";
import { curateMemoryAfterRun } from "./memoryCurator.js";
import { initStagehandSession, destroyStagehandSession, type StagehandSession } from "./stagehandBridge.js";
import { attachNetworkMonitor, type NetworkMonitorResult } from "./networkMonitor.js";
import { dedupeRunStepBugs } from "./bugDedup.js";
import type { StorageAdapter } from "./storage.js";

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
  onAgentPlan?: (items: AgentPlanItem[]) => void;
  onActivity?: (activity: { kind: "observe"; text: string; at: number }) => void;
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer, domHash: string) => void;
  onLLMCall?: (call: LLMCallRecord) => void;
  /** Optional extra stop check (e.g. Redis-backed signal from API process). Combined with in-process isStopRequested. */
  shouldStop?: () => boolean;
};

export type RunResult = {
  status: "passed" | "failed";
  steps: string[];
  stepsDetail: RunStep[];
  memoryLoaded: MemoryEntry[];
  memoryProposed: number;
  bugsFound: RunStep[];
  llmCalls: LLMCallRecord[];
  videoUrl?: string;
  error?: string;
};

export async function runOrchestratedJob(storage: StorageAdapter, job: RunJob): Promise<RunResult> {
  const config = getConfig();

  // When running inside Docker, the browser cannot reach `localhost` — that resolves to the
  // container itself, not the host machine. Historically we rewrote URLs to
  // `host.docker.internal`, but that made ClerkJS report a key-mismatch redirect loop because
  // `host.docker.internal` is not in Clerk's Dashboard allowed-origins list (and never will be
  // for apps that haven't configured it). The fix is to keep all app URLs as `localhost` and
  // instead tell Chrome to resolve `localhost` to `host.docker.internal` at the DNS layer via
  // --host-resolver-rules. From the browser's security model the origin stays `localhost`, so
  // Clerk (and any other auth provider) accepts it without any dashboard configuration.
  const DOCKER_BROWSER_ARGS = process.env.KERY_DOCKER
    ? ["--host-resolver-rules=MAP localhost host.docker.internal"]
    : [];

  logger.info({ intent: job.intent }, "Starting orchestrated run");

  let context = job.context ?? "";
  let targetUrl: string | undefined;

  // Runs created from a page/destination (i.e. `destinationId` without a saved `testId`)
  // don't carry `maxSteps`, so apply a higher default for page tests.
  const isPageTest = Boolean(job.destinationId) && !job.testId;
  const maxStepsForRun = job.maxSteps ?? (isPageTest ? 200 : undefined);

  // For page tests, compute the navigation target URL. Navigator plans from what it sees on the page.
  if (job.destinationId) {
    try {
      const dest = await storage.getDestination(job.destinationId);
      if (dest) {
        targetUrl = buildTargetUrl(job.baseUrl, dest.normalized_route);
      }
    } catch (err) {
      logger.warn({ err: String(err), destinationId: job.destinationId }, "Failed to resolve target URL");
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

  // Load memory (with in-memory decay for prompt; DB rows unchanged until curator/boost)
  let destinationRoute: string | undefined;
  if (job.destinationId) {
    try {
      const d = await storage.getDestination(job.destinationId);
      destinationRoute = d?.normalized_route;
    } catch {
      /* ignore */
    }
  }
  const projectMemory = job.projectId ? await loadProjectMemoryWithDecay(storage, job.projectId) : [];
  const pageMemory = job.destinationId ? await loadPageMemoryWithDecay(storage, job.destinationId) : [];
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
  const recordW = 1920;
  const recordH = 1080;

  try {
    if (config.stagehandEnabled) {
      const videoOpts = videoTmpDir
        ? ({ recordVideo: { dir: videoTmpDir, size: { width: recordW, height: recordH } } } as const)
        : undefined;
      try {
        shSession = await initStagehandSession(videoOpts);
      } catch (err) {
        const msg = String(err);
        if (videoTmpDir && /ffmpeg/i.test(msg)) {
          logger.warn({ err: msg.slice(0, 240) }, "Stagehand: ffmpeg/video init failed — retrying without recording");
          try {
            shSession = await initStagehandSession(undefined);
          } catch (err2) {
            logger.warn({ err: String(err2).slice(0, 200) }, "Stagehand session init failed — falling back to plain Playwright");
            shSession = undefined;
          }
        } else {
          logger.warn({ err: msg.slice(0, 200) }, "Stagehand session init failed — falling back to plain Playwright");
          shSession = undefined;
        }
      }
    }

    let page;
    let videoEnabled = !!videoTmpDir;
    if (shSession) {
      page = shSession.page;
      await page.setViewportSize({ width: recordW, height: recordH }).catch((e) =>
        logger.warn({ err: String(e).slice(0, 160) }, "setViewportSize (non-fatal)"),
      );
    } else {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", ...DOCKER_BROWSER_ARGS],
      });
      const contextOpts: any = { viewport: { width: recordW, height: recordH } };
      if (videoTmpDir) {
        contextOpts.recordVideo = { dir: videoTmpDir, size: { width: recordW, height: recordH } };
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

    const netMonitor = attachNetworkMonitor(page);

    // Try regression replay
    if (regressionPlan && regressionPlan.length > 0) {
      try {
        if (job.auth) {
          let authed = (await handleAuth(page, job.auth, context, job.baseUrl)).ok;
          // Retry auth once before giving up
          if (!authed) {
            logger.warn("Regression replay: first auth attempt failed, retrying once");
            authed = (await handleAuth(page, job.auth, context, job.baseUrl)).ok;
          }
          if (!authed) {
            logger.warn("Regression replay: auth failed after retry, falling back to Navigator");
            regressionPlan = null;
          }
        }
      } catch (authErr) {
        logger.warn({ err: String(authErr).slice(0, 200) }, "Regression replay: auth threw, falling back to Navigator");
        regressionPlan = null;
      }
    }

    if (regressionPlan && regressionPlan.length > 0) {
      try {
        const regLiveSteps: RunStep[] = [];
        const regResult = await executeRegressionPlan(page, regressionPlan, {
          onStep: (step) => {
            regLiveSteps.push(step);
            job.onStep?.(step);
          },
          onScreenshot: (screenshot, cleanScreenshot, domHash) => {
            job.onScreenshot?.(screenshot, cleanScreenshot, domHash);
          },
          onHealCall: (call) => {
            job.onLLMCall?.(call);
          },
        });

        if (regResult.status === "passed" || regResult.status === "failed") {
          if (regressionSource) {
            const current = await storage.getRegressionPlan(regressionSource.table, regressionSource.id);
            const newCount = updatePlanConfidence(current?.plan_success_count ?? 0, regResult);
            await storage.updateRegressionPlan(regressionSource.table, regressionSource.id, {
              plan_success_count: newCount, plan_status: "ready",
            });
          }

          const stepsDetail: RunStep[] = regLiveSteps.length > 0
            ? regLiveSteps
            : regressionPlan.map((step, i) => ({
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

          if (shSession) {
            await finalizeStagehandRecording(shSession, videoTmpDir, job.runId);
          } else {
            await browserContext?.close();
            await browser?.close();
          }

          const videoUrl = await finalizeVideo(videoTmpDir, job.videosDir, job.runId);

          return {
            status: regResult.status === "passed" ? "passed" : "failed",
            steps: stepsDetail.map(s => `[${s.index}] ${s.action} \u2192 ${s.target ?? ""}`),
            stepsDetail, bugsFound, llmCalls: regResult.healCalls,
            memoryLoaded: allMemory, memoryProposed: 0, videoUrl,
          };
        }

        // handoff — script got as far as it could, Navigator takes over from here
        const completedCount = regResult.failedAtStep ?? 0;
        const completedSummary = (regResult.completedSteps ?? [])
          .map((s, i) => `  ${i + 1}. ${s.action} ${s.role ? `${s.role}:` : ""}${s.name ? `"${s.name}"` : ""}${s.value ? ` = "${s.value}"` : ""}`)
          .join("\n");

        const handoffContext = [
          context,
          `\n--- Regression script partial execution ---`,
          `${completedCount} of ${regressionPlan.length} scripted steps completed successfully before a step failed.`,
          completedCount > 0
            ? `Completed steps:\n${completedSummary}`
            : `No steps completed before the failure.`,
          `The browser is currently at: ${page.url()}`,
          `Continue from the current page state and complete the original intent. Do NOT redo the already-completed steps above.`,
        ].join("\n");

        logger.info(
          { failedAtStep: regResult.failedAtStep, currentUrl: page.url() },
          "Regression handoff: Navigator taking over mid-flow",
        );

        if (regressionSource) {
          await storage.updateRegressionPlan(regressionSource.table, regressionSource.id, {
            plan_status: "stale", plan_success_count: 0,
          });
        }

        const completedRunSteps: RunStep[] = regLiveSteps.length > 0
          ? regLiveSteps.filter((s) => s.status === "ok")
          : (regResult.completedSteps ?? []).map((step, i) => ({
              index: i + 1, action: step.action, target: step.name, value: step.value,
              reasoning: step.purpose, url: step.url ?? page.url(),
              status: "ok" as const, fromMemory: false, at: Date.now(),
              elementRef: step.role && step.name ? { role: step.role, name: step.name } : undefined,
            }));

        context = handoffContext;
        (job as any).__handoffCompletedSteps = completedRunSteps;
        (job as any).__handoffHealCalls = regResult.healCalls;
      } catch {
        // Fall through to LLM exploration
      }
    }

    // Full LLM exploration
    const holisticCalls: LLMCallRecord[] = [];
    let lastFrameDomHash: string | null = null;
    const filmstripFrames: FilmstripFrame[] = [];
    const FILMSTRIP_MAX = 30;
    const screenshotsByStep = new Map<number, string>(); // Keyed by agent step.index
    let latestCleanScreenshot: string | undefined;

    const agentResult = await runAgent(
      page, job.intent, job.baseUrl, job.auth ?? null, allMemory,
      context,
      (step) => {
        if (latestCleanScreenshot) {
          screenshotsByStep.set(step.index, latestCleanScreenshot);
        }
        job.onStep?.(step);
      },
      async (screenshot, cleanScreenshot, domHash) => {
        job.onScreenshot?.(screenshot, cleanScreenshot, domHash);
        const url = page.url();
        if (cleanScreenshot.length > 0) {
          latestCleanScreenshot = cleanScreenshot.toString("base64");
          if (domHash !== lastFrameDomHash) {
            filmstripFrames.push({ url, base64: latestCleanScreenshot });
            lastFrameDomHash = domHash;
            while (filmstripFrames.length > FILMSTRIP_MAX) {
              filmstripFrames.shift();
            }
          }
        }
      },
      job.onLLMCall, job.onAgentPlan, job.onActivity, maxStepsForRun, targetUrl, shSession,
      !job.runId && !job.shouldStop
        ? undefined
        : () => (job.shouldStop?.() ?? false) || (job.runId ? isStopRequested(job.runId) : false),
      netMonitor,
    );

    // Capture the final page state so holistic/filmstrip review sees the end result
    try {
      const finalSS = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => Buffer.alloc(0));
      if (finalSS.length > 0) {
        const finalB64 = finalSS.toString("base64");
        const finalUrl = page.url();
        if (finalB64 !== latestCleanScreenshot) {
          filmstripFrames.push({ url: finalUrl, base64: finalB64 });
          latestCleanScreenshot = finalB64;
        }
      }
    } catch { /* page may be closed */ }

    netMonitor.stop();
    const netSummary = netMonitor.formatForAgent() || undefined;
    const netBugs = netMonitor.getBugs();

    const { bugs: holisticBugs } = await runHolisticFlowReview(
      {
        intent: job.intent,
        stepsDetail: agentResult.stepsDetail,
        frames: filmstripFrames,
        navigatorStatus: agentResult.status === "passed" ? "passed" : "failed",
        networkSummary: netSummary,
      },
      {
        onLLMCall: (call) => holisticCalls.push({ ...call, seq: 0 }),
      },
    );

    const filmstripCalls: LLMCallRecord[] = [];
    const { bugs: filmstripBugs } = await runFilmstripReview(filmstripFrames, {
      onLLMCall: (call) => filmstripCalls.push({ ...call, seq: 0 }),
    });
    let bugsFound = mergeBugs(
      agentResult.stepsDetail,
      [...holisticBugs, ...filmstripBugs],
      screenshotsByStep,
      agentResult.bugsFound,
    );

    // Merge action-correlated network bugs (capped, API-only, mutating-request errors)
    if (netBugs.length > 0) {
      const maxIdx = Math.max(0, ...agentResult.stepsDetail.map(s => s.index ?? 0));
      for (const nb of netBugs) {
        bugsFound.push({
          index: maxIdx + 1,
          action: "bug",
          reasoning: `[Network] ${nb.description}`,
          status: "ok" as const,
          fromMemory: false,
          bugType: "functional" as const,
          severity: nb.severity as "low" | "medium" | "high",
          source: "navigator" as const,
          at: nb.at ?? Date.now(),
        });
      }
      logger.info({ count: netBugs.length }, "Network monitor: action-correlated bugs merged");
    }
    const memoryCuratorCalls: LLMCallRecord[] = [];

    if (agentResult.status === "passed" && allMemory.length > 0) {
      await boostConfidence(storage, allMemory.map((e) => e.id), 3);
    }

    const { proposed: memoryProposed } = await curateMemoryAfterRun(storage, {
      intent: job.intent,
      runStatus: agentResult.status === "passed" ? "passed" : "failed",
      stepsDetail: agentResult.stepsDetail,
      projectId: job.projectId,
      destinationId: job.destinationId,
      destinationRoute,
      projectMemory,
      pageMemory,
      onLLMCall: (call) => {
        memoryCuratorCalls.push(call);
        job.onLLMCall?.(call);
      },
    });

    const handoffHealCalls: LLMCallRecord[] = (job as any).__handoffHealCalls ?? [];
    const mergedCalls = mergeLLMCalls(agentResult.llmCalls, holisticCalls, filmstripCalls, memoryCuratorCalls, handoffHealCalls);

    // If this was a handoff run, prepend the completed regression steps so the
    // combined trace represents the full flow. Re-index all steps sequentially.
    const handoffCompleted: RunStep[] = (job as any).__handoffCompletedSteps ?? [];
    const combinedStepsDetail: RunStep[] = handoffCompleted.length > 0
      ? [
          ...handoffCompleted,
          ...agentResult.stepsDetail.map(s => ({ ...s, index: (s.index ?? 0) + handoffCompleted.length })),
        ]
      : agentResult.stepsDetail;

    // If the Navigator completed the flow successfully after a handoff, save a
    // fresh regression plan from the combined trace so the script is repaired.
    if (handoffCompleted.length > 0 && agentResult.status === "passed" && regressionSource) {
      const { plan: freshPlan } = await generateScriptWithLLM(job.intent, combinedStepsDetail, job.onLLMCall);
      if (freshPlan.length > 0) {
        await storage.updateRegressionPlan(regressionSource.table, regressionSource.id, {
          regression_plan: freshPlan,
          plan_status: "ready",
          plan_success_count: 1,
        });
        logger.info(
          { steps: freshPlan.length, source: regressionSource },
          "Regression: script regenerated from handoff+navigator combined trace",
        );
      }
    }

    if (shSession) {
      await finalizeStagehandRecording(shSession, videoTmpDir, job.runId);
    } else {
      await browserContext?.close();
      await browser?.close();
    }

    const videoUrl = await finalizeVideo(videoTmpDir, job.videosDir, job.runId);

    const finalStatus = agentResult.status;

    mergedCalls.forEach((c, i) => { c.seq = i + 1; });

    return {
      status: finalStatus,
      steps: combinedStepsDetail.map(s => `[${s.index}] ${s.action} \u2192 ${s.target ?? ""}`),
      stepsDetail: combinedStepsDetail,
      memoryLoaded: allMemory, memoryProposed: memoryProposed,
      bugsFound, llmCalls: mergedCalls, videoUrl,
    };
  } catch (err) {
    logger.error({ err: String(err) }, "Run failed");
    if (shSession) {
      await destroyStagehandSession(shSession).catch((e) =>
        logger.warn({ err: String(e).slice(0, 200) }, "Stagehand destroy after run error (non-fatal)"),
      );
    }
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

function mergeLLMCalls(
  navigator: LLMCallRecord[],
  holistic: LLMCallRecord[],
  filmstrip: LLMCallRecord[] = [],
  memoryCurator: LLMCallRecord[] = [],
  healCalls: LLMCallRecord[] = [],
): LLMCallRecord[] {
  const merged: LLMCallRecord[] = [
    ...healCalls.map((c) => ({ ...c, agent: "regression_heal" as LLMAgentType })),
    ...navigator.map((c) => ({ ...c, agent: (c.agent ?? "navigator") as LLMAgentType })),
    ...holistic.map((c) => ({ ...c, agent: (c.agent ?? "holistic") as LLMAgentType })),
    ...filmstrip.map((c) => ({ ...c, agent: (c.agent ?? "filmstrip") as LLMAgentType })),
    ...memoryCurator.map((c) => ({ ...c, agent: (c.agent ?? "memory_curator") as LLMAgentType })),
  ];
  merged.forEach((c, i) => { c.seq = i + 1; });
  return merged;
}

/** RunStep.bugType is a coarser UI taxonomy than ReviewBug.type */
function reviewTypeToStepBugType(t: ReviewBug["type"]): NonNullable<RunStep["bugType"]> {
  switch (t) {
    case "visual":
      return "visual";
    case "ux":
      return "ux";
    case "behavioral":
      return "functional";
    case "a11y":
    case "performance":
    case "data":
      return "other";
  }
}

function mergeBugs(
  stepsDetail: RunStep[], reviewBugs: ReviewBug[],
  screenshotsByStep?: Map<number, string>,
  navigatorBugs?: RunStep[],
): RunStep[] {
  const out: RunStep[] = [];
  for (const bug of navigatorBugs ?? []) {
    if (bug.action !== "bug") continue;
    out.push({
      ...bug,
      screenshotBase64: bug.screenshotBase64 ?? screenshotsByStep?.get(bug.index ?? 0),
      source: "navigator",
    });
  }
  for (const step of stepsDetail) {
    if (step.action === "bug" && step.source === "navigator") {
      out.push({
        ...step,
        screenshotBase64: step.screenshotBase64 ?? screenshotsByStep?.get(step.index ?? 0),
      });
      continue;
    }
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
    const bugType = reviewTypeToStepBugType(b.type);
    const src = b.source === "filmstrip" ? "filmstrip" : "review";
    out.push({
      index: b.stepIndex, action: "bug", reasoning: b.description,
      status: "ok", fromMemory: false, bugType, severity: b.severity,
      source: src, at: b.at,
      region: b.region,
      screenshotBase64: b.screenshotBase64,
    });
  }
  const deduped = dedupeRunStepBugs(out);
  deduped.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return deduped;
}

// ─── Video helpers ──────────────────────────────────────────────────────────

/** Close Stagehand page, write video with Playwright Video.saveAs, then destroy session. */
async function finalizeStagehandRecording(
  shSession: StagehandSession,
  videoTmpDir: string | undefined,
  runId: string | undefined,
): Promise<void> {
  try {
    const shPage = shSession.page;
    const videoHandle = videoTmpDir ? shPage.video() : null;
    await shPage.close().catch((e) =>
      logger.warn({ err: String(e).slice(0, 200) }, "Stagehand page.close (non-fatal)"),
    );
    if (videoTmpDir && videoHandle) {
      try {
        const name = runId ? `${runId}.webm` : "recording.webm";
        const destPath = path.join(videoTmpDir, name);
        fs.mkdirSync(videoTmpDir, { recursive: true });
        await videoHandle.saveAs(destPath);
        logger.info({ runId, destPath }, "Stagehand video saved via saveAs");
      } catch (videoErr) {
        logger.warn({ err: String(videoErr).slice(0, 280) }, "Stagehand video saveAs failed");
      }
    }
    await destroyStagehandSession(shSession).catch((err) => {
      logger.warn({ err: String(err).slice(0, 200) }, "Stagehand destroy error (non-fatal)");
    });
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Stagehand cleanup error");
  }
}

function pickWebmSource(tmpDir: string, runId: string): string | undefined {
  const allFiles = fs.readdirSync(tmpDir);
  const webms = allFiles.filter((f) => f.endsWith(".webm"));
  if (webms.length === 0) return undefined;

  const named = `${runId}.webm`;
  if (webms.includes(named)) {
    try {
      const p = path.join(tmpDir, named);
      if (fs.statSync(p).size > 0) return p;
    } catch {
      /* fall through — empty or missing saveAs output */
    }
  }
  // Playwright may also write a UUID.webm; pick the largest non-empty file (avoids stale/partial duplicates).
  let best: { p: string; size: number } | undefined;
  for (const f of webms) {
    const p = path.join(tmpDir, f);
    try {
      const size = fs.statSync(p).size;
      if (size > 0 && (!best || size > best.size)) best = { p, size };
    } catch {
      /* skip */
    }
  }
  return best?.p;
}

async function finalizeVideo(
  tmpDir: string | undefined,
  videosDir: string | undefined,
  runId: string | undefined,
): Promise<string | undefined> {
  if (!tmpDir || !runId) return undefined;
  try {
    const srcPath = pickWebmSource(tmpDir, runId);
    if (!srcPath) {
      const allFiles = fs.readdirSync(tmpDir);
      logger.warn(
        { tmpDir, runId, fileCount: allFiles.length, names: allFiles.slice(0, 15) },
        "Video finalize: no .webm in temp dir (verify recordVideo / ffmpeg / saveAs path)",
      );
      return undefined;
    }

    const destDir = videosDir || path.join(process.cwd(), "data", "videos");
    fs.mkdirSync(destDir, { recursive: true });

    const destFile = `${runId}.webm`;
    const destPath = path.join(destDir, destFile);
    fs.copyFileSync(srcPath, destPath);

    const outSize = fs.statSync(destPath).size;
    if (outSize < 256) {
      logger.warn({ runId, outSize, srcPath }, "Video finalize: output too small, discarding");
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* ignore */
      }
      cleanupVideoTmpDir(tmpDir);
      return undefined;
    }

    // Remove temp copy(ies) in the recording dir
    for (const f of fs.readdirSync(tmpDir).filter((x) => x.endsWith(".webm"))) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {
        /* ignore */
      }
    }

    cleanupVideoTmpDir(tmpDir);
    logger.info({ runId, path: destPath, bytes: outSize }, "Video recording saved");
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
