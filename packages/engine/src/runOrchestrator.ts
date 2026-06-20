/**
 * Run Orchestrator — multi-agent orchestration for test runs.
 * Accepts StorageAdapter for all database operations.
 *
 * experiment/pure-llm-runs: regression scripts completely removed.
 * Every run is a fresh LLM Navigator run — no script lookup, no replay,
 * no healing, no script generation. Pure LLM every time.
 */
import { chromium, type Page, type BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getConfig } from "./config.js";
import { logger, serializeError } from "./logger.js";
import { runAgent, type RunStep, type LLMCallRecord, type LLMAgentType, type AgentPlanItem, type AgentResult } from "./agent.js";
import type { AuthConfig } from "./types.js";
import { runFilmstripReview, type FilmstripFrame } from "./filmstripReview.js";
import { runHolisticFlowReview } from "./holisticReviewAgent.js";
import { isStopRequested } from "./runEvents.js";
import type { ReviewBug } from "./types.js";
import {
  loadProjectMemoryWithDecay,
  boostConfidence,
  type MemoryEntry,
} from "./agentMemory.js";
import { curateMemoryAfterRun } from "./memoryCurator.js";
import { initStagehandSession, destroyStagehandSession, type StagehandSession } from "./stagehandBridge.js";
import { attachNetworkMonitor, type NetworkMonitorResult } from "./networkMonitor.js";
import { dedupeRunStepBugs } from "./bugDedup.js";
import { runBugTriageAgent } from "./bugTriageAgent.js";
import { runFlowDiscoveryAgent, deduplicateFlowsWithLLM } from "./flowDiscoveryAgent.js";
import type { StorageAdapter } from "./storage.js";
import { dockerHostResolverArgs } from "./dockerHost.js";

export type RunJob = {
  runId?: string;
  baseUrl: string;
  intent: string;
  projectId?: string;
  auth?: AuthConfig | null;
  testId?: string;
  context?: string;
  saveScreenshots?: boolean;
  maxSteps?: number;
  recordVideo?: boolean;
  videosDir?: string;
  triggerRef?: string;
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
  /** Epoch ms when Playwright started recording — used to sync video time with step timestamps. */
  recordingStartedAt?: number;
  error?: string;
};

export async function runOrchestratedJob(storage: StorageAdapter, job: RunJob): Promise<RunResult> {
  const config = getConfig();
  const emitActivity = (text: string) => {
    job.onActivity?.({ kind: "observe", text, at: Date.now() });
  };

  const DOCKER_BROWSER_ARGS = dockerHostResolverArgs();

  logger.info({ intent: job.intent }, "Starting orchestrated run");

  let context = job.context ?? "";
  let targetUrl: string | undefined;

  const maxStepsForRun = job.maxSteps;

  // Load memory (with in-memory decay for prompt; DB rows unchanged until curator/boost)
  const projectMemory = job.projectId ? await loadProjectMemoryWithDecay(storage, job.projectId) : [];
  const allMemory = projectMemory;

  // Launch browser
  let browser;
  let browserContext: BrowserContext | undefined;
  let shSession: StagehandSession | undefined;
  let lastAgentResult: AgentResult | undefined;
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

    // Capture recording start epoch so the frontend can sync video time with step timestamps.
    const recordingStartedAt = videoEnabled ? Date.now() : undefined;

    const netMonitor = attachNetworkMonitor(page);

    // Pure LLM exploration — no regression replay, no scripted steps
    const holisticCalls: LLMCallRecord[] = [];
    let lastFrameDomHash: string | null = null;
    const filmstripFrames: FilmstripFrame[] = [];
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
            // Collect all unique frames without dropping — capFilmstripFrames
            // does stride-based subsampling at send time, preserving coverage
            // across the full journey rather than losing early pages.
            filmstripFrames.push({ url, base64: latestCleanScreenshot });
            lastFrameDomHash = domHash;
          }
        }
      },
      job.onLLMCall, job.onAgentPlan, job.onActivity, maxStepsForRun, targetUrl, shSession,
      !job.runId && !job.shouldStop
        ? undefined
        : () => (job.shouldStop?.() ?? false) || (job.runId ? isStopRequested(job.runId) : false),
      netMonitor,
    );
    lastAgentResult = agentResult;

    const wasStopped = agentResult.failReason === "Stopped by user";
    const isAuthTest = job.triggerRef === "auth_test";
    const isConnectionTest = job.triggerRef === "connection_test";
    const isVerificationRun = isAuthTest || isConnectionTest;
    const isDiscovery = job.triggerRef === "discovery";

    // Hard stop — close browser immediately and return without any post-run work.
    // No review agents, no bug triage, no memory curator, no saved bugs.
    if (wasStopped) {
      netMonitor.stop();
      if (shSession) {
        await finalizeStagehandRecording(shSession, videoTmpDir, job.runId).catch(() => {});
      } else {
        await browserContext?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
      cleanupVideoTmpDir(videoTmpDir);
      const stoppedCalls = collectedLLMCalls.map((c, i) => ({ ...c, seq: i + 1 }));
      return {
        status: "failed",
        steps: agentResult.steps,
        stepsDetail: agentResult.stepsDetail,
        memoryLoaded: allMemory,
        memoryProposed: 0,
        bugsFound: [],
        llmCalls: stoppedCalls,
        error: "Stopped by user",
      };
    }

    // Discovery run: skip bug review pipeline, extract flows and write them to storage.
    if (isDiscovery) {
      netMonitor.stop();
      if (shSession) {
        await finalizeStagehandRecording(shSession, videoTmpDir, job.runId).catch(() => {});
      } else {
        await browserContext?.close();
        await browser?.close();
      }
      const videoUrl = await finalizeVideo(videoTmpDir, job.videosDir, job.runId);
      const discoveryCalls: LLMCallRecord[] = [];
      emitActivity("Extracting flows from exploration...");
      const discoveryResult = await runFlowDiscoveryAgent(agentResult.stepsDetail, {
        onLLMCall: (call) => {
          discoveryCalls.push({ ...call, seq: 0 });
          job.onLLMCall?.({ ...call, seq: 0 });
        },
      });
      if (discoveryResult.flows.length > 0 && job.projectId) {
        const existingTests = await storage.getExistingTests(job.projectId).catch(() => [] as { name: string; intent: string }[]);
        const newFlows = await deduplicateFlowsWithLLM(discoveryResult.flows, existingTests, {
          onLLMCall: (call) => {
            discoveryCalls.push({ ...call, seq: 0 });
            job.onLLMCall?.({ ...call, seq: 0 });
          },
        });
        const autoScanGroupId = await storage.ensureAutoScanGroup(job.projectId).catch(() => undefined);
        let savedCount = 0;
        for (const flow of newFlows) {
          try {
            await storage.createSavedTest({
              project_id: job.projectId,
              name: flow.name,
              intent: flow.intent,
              discovery_source: "auto",
              discovery_run_id: job.runId,
              group_id: autoScanGroupId,
            });
            savedCount++;
          } catch (err) {
            logger.error({ err: String(err), flowName: flow.name }, "Flow discovery: failed to save flow — check DB schema (discovery_run_id column may be missing)");
          }
        }
        emitActivity(newFlows.length > 0 ? `Created ${savedCount} new flows.` : "No new flows found.");
        logger.info({ discovered: discoveryResult.flows.length, dedupedNew: newFlows.length, saved: savedCount }, "Flow discovery: complete");
      }
      const mergedCalls = [
        ...agentResult.llmCalls.map((c) => ({ ...c, agent: (c.agent ?? "navigator") as LLMAgentType })),
        ...discoveryCalls.map((c) => ({ ...c, agent: "flow_discovery" as LLMAgentType })),
      ];
      mergedCalls.forEach((c, i) => { c.seq = i + 1; });
      return {
        status: agentResult.status,
        steps: agentResult.stepsDetail.map(s => `[${s.index}] ${s.action} → ${s.target ?? ""}`),
        stepsDetail: agentResult.stepsDetail,
        memoryLoaded: allMemory,
        memoryProposed: 0,
        bugsFound: [],
        llmCalls: mergedCalls,
        videoUrl,
        recordingStartedAt,
        error: agentResult.status === "failed" ? agentResult.failReason : undefined,
      };
    }

    // Capture the final page state for holistic review (uses clean screenshot from agent
    // if available; raw fallback only goes to holistic, not filmstrip, since filmstrip
    // already has clean coverage from the run and the final raw frame may have overlays).
    let holisticFinalFrames = [...filmstripFrames];
    try {
      const finalSS = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => Buffer.alloc(0));
      if (finalSS.length > 0) {
        const finalB64 = finalSS.toString("base64");
        const finalUrl = page.url();
        if (finalB64 !== latestCleanScreenshot) {
          holisticFinalFrames = [...filmstripFrames, { url: finalUrl, base64: finalB64 }];
          latestCleanScreenshot = finalB64;
        }
      }
    } catch { /* page may be closed */ }

    netMonitor.stop();
    const netSummary = netMonitor.formatForAgent() || undefined;
    const netBugs = netMonitor.getBugs();

    const filmstripCalls: LLMCallRecord[] = [];
    const navigatorStatus = agentResult.status === "passed" ? "passed" : "failed";

    emitActivity("Running post-run review agents...");
    const [{ bugs: holisticBugs }, { bugs: filmstripBugs }] = isVerificationRun
      ? [{ bugs: [] }, { bugs: [] }]
      : await Promise.all([
          runHolisticFlowReview(
            {
              intent: job.intent,
              stepsDetail: agentResult.stepsDetail,
              frames: holisticFinalFrames,
              navigatorStatus,
              networkSummary: netSummary,
            },
            { onLLMCall: (call) => holisticCalls.push({ ...call, seq: 0 }) },
          ),
          runFilmstripReview(filmstripFrames, {
            onLLMCall: (call) => filmstripCalls.push({ ...call, seq: 0 }),
            intent: job.intent,
            navigatorStatus,
          }),
        ]);
    emitActivity("Post-run review complete.");
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
    const triageCalls: LLMCallRecord[] = [];
    let triageResult: Awaited<ReturnType<typeof runBugTriageAgent>>;
    if (isVerificationRun) {
      triageResult = { bugs: bugsFound, skippedCount: 0, llmCall: null };
    } else {
      const openProjectBugs = job.projectId
        ? await storage.getOpenBugs(job.projectId, 100_000).catch(() => [])
        : [];
      emitActivity("Running bug triage agent...");
      triageResult = await runBugTriageAgent(
        {
          bugs: bugsFound,
          intent: job.intent,
          openProjectBugs,
          memoryEntries: allMemory,
        },
        { onLLMCall: (call) => triageCalls.push({ ...call, seq: 0 }) },
      );
      emitActivity("Bug triage complete.");
    }
    bugsFound = triageResult.bugs;
    if (triageResult.skippedCount > 0) {
      logger.info(
        { skippedCount: triageResult.skippedCount, remaining: bugsFound.length },
        "Bug triage: filtered run bug candidates",
      );
    }
    const memoryCuratorCalls: LLMCallRecord[] = [];
    let memoryProposed = 0;

    if (!isVerificationRun) {
      if (agentResult.status === "passed" && allMemory.length > 0) {
        await boostConfidence(storage, allMemory.map((e) => e.id), 3);
      }

      emitActivity("Running memory curator...");
      const curatorResult = await curateMemoryAfterRun(storage, {
        intent: job.intent,
        runStatus: agentResult.status === "passed" ? "passed" : "failed",
        stepsDetail: agentResult.stepsDetail,
        projectId: job.projectId,
        projectMemory,
        onLLMCall: (call) => {
          memoryCuratorCalls.push(call);
          job.onLLMCall?.(call);
        },
      });
      memoryProposed = curatorResult.proposed;
      emitActivity("Memory curation complete.");
    }

    const mergedCalls = mergeLLMCalls(
      agentResult.llmCalls,
      holisticCalls,
      filmstripCalls,
      triageCalls,
      memoryCuratorCalls,
    );

    const combinedStepsDetail = agentResult.stepsDetail;

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
      recordingStartedAt,
      error: finalStatus === "failed" ? agentResult.failReason : undefined,
    };
  } catch (err) {
    const errorInfo = serializeError(err);
    const errorMessage = typeof errorInfo.message === "string" ? errorInfo.message : String(err);
    logger.error({ err: errorInfo, runId: job.runId, baseUrl: job.baseUrl }, "Run failed");
    if (shSession) {
      await destroyStagehandSession(shSession).catch((e) =>
        logger.warn({ err: serializeError(e) }, "Stagehand destroy after run error (non-fatal)"),
      );
    }
    else {
      await browserContext?.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
    cleanupVideoTmpDir(videoTmpDir);
    const fallbackStep: RunStep = {
      index: 1,
      action: "navigate",
      target: job.baseUrl,
      reasoning: "Run failed before the navigator could complete.",
      url: job.baseUrl,
      status: "failed",
      error: errorMessage,
      fromMemory: false,
      at: Date.now(),
    };
    const stepsDetail = lastAgentResult?.stepsDetail?.length ? lastAgentResult.stepsDetail : [fallbackStep];
    return {
      status: "failed",
      steps: stepsDetail.map(s => `[${s.index}] ${s.action} \u2192 ${s.target ?? ""}${s.error ? ` (${s.error})` : ""}`),
      stepsDetail,
      memoryLoaded: allMemory,
      memoryProposed: 0,
      bugsFound: [],
      llmCalls: collectedLLMCalls,
      error: errorMessage,
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
  triage: LLMCallRecord[] = [],
  memoryCurator: LLMCallRecord[] = [],
): LLMCallRecord[] {
  const merged: LLMCallRecord[] = [
    ...navigator.map((c) => ({ ...c, agent: (c.agent ?? "navigator") as LLMAgentType })),
    ...holistic.map((c) => ({ ...c, agent: (c.agent ?? "holistic") as LLMAgentType })),
    ...filmstrip.map((c) => ({ ...c, agent: (c.agent ?? "filmstrip") as LLMAgentType })),
    ...triage.map((c) => ({ ...c, agent: (c.agent ?? "bug_triage") as LLMAgentType })),
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
