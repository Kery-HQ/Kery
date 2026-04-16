// ─── Docker Host ────────────────────────────────────────────────────────────
export { rewriteForDocker } from "./dockerHost.js";

// ─── Config ──────────────────────────────────────────────────────────────────
export {
  initEngineConfig,
  getConfig,
  updateEngineConfig,
  MODEL_CONFIG_KEYS,
  type EngineConfig,
  type ModelConfigKey,
} from "./config.js";
export { logger, withRunCorrelation, getRunCorrelationId } from "./logger.js";

// ─── Storage ─────────────────────────────────────────────────────────────────
export type { StorageAdapter } from "./storage.js";

// ─── Types ───────────────────────────────────────────────────────────────────
export * from "./types.js";

// ─── Agent ───────────────────────────────────────────────────────────────────
export { runAgent, handleAuth, waitForPageStable, executeAction, serializeWireMessagesForStorage } from "./agent.js";
export type {
  AgentAction, RunStep, LLMCallRecord, AgentResult, LLMAgentType, LLMStoredMessage, LLMStoredContentPart,
  AuthHandleResult, DoneResult, AgentPlanItem,
} from "./agent.js";

// ─── Token Auth (Clerk, Supabase) ────────────────────────────────────────────
export { handleTokenAuth, authenticateWithClerk, authenticateWithSupabase, refreshIfNeeded } from "./tokenAuth.js";

// ─── Memory ──────────────────────────────────────────────────────────────────
export {
  loadProjectMemory, loadPageMemory,
  loadProjectMemoryWithDecay, loadPageMemoryWithDecay,
  saveProjectMemoryEntries, savePageMemoryEntries,
  formatMemoryForPrompt, proposeMemoriesFromRun, boostConfidence,
} from "./agentMemory.js";
export { curateMemoryAfterRun } from "./memoryCurator.js";
export type { CurateMemoryInput, CurateMemoryResult } from "./memoryCurator.js";
export type { MemoryEntry, MemoryEntryInsert, MemoryEntryType, MemorySource } from "./agentMemory.js";

// ─── LLM ─────────────────────────────────────────────────────────────────────
export { llmChat, llmAgentChat, llmSummarize, llmMemoryCurate, calcCostUsd, getLLMBase, MAX_OUTPUT_TOKENS } from "./llmClient.js";
export type { LLMUsage, MemoryCurationParsed } from "./llmClient.js";
export {
  inferModelProviderRequirement,
  isModelRunnableWithConfig,
  modelUnavailableReason,
  getLlmKeyPresence,
} from "./llmProviders.js";
export type { DirectModelProvider, ModelProviderRequirement } from "./llmProviders.js";

// ─── A11y Tree ───────────────────────────────────────────────────────────────
export { extractA11yTree, formatA11yForLLM, hasSufficientA11y, resolveElement, injectElementMarkers, removeElementMarkers, extractVisibleText } from "./a11yTree.js";
export type { A11yElement, A11yTextNode } from "./a11yTree.js";

// ─── Stagehand ───────────────────────────────────────────────────────────────
export { initStagehandSession, destroyStagehandSession, stagehandObserve, stagehandAct, actionToInstruction, formatObserveForLLM, hasSufficientObserve, isObserveCircuitOpen } from "./stagehandBridge.js";
export type { StagehandSession, ObservedElement, StagehandActResult } from "./stagehandBridge.js";

// ─── Plan Tracker ────────────────────────────────────────────────────────────
export { PlanTracker } from "./planTracker.js";
export type { TrackedStep, MicroGoal } from "./planTracker.js";

// ─── Regression Engine ───────────────────────────────────────────────────────
export { evaluateCondition, generateRegressionPlan, executeRegressionPlan, updatePlanConfidence } from "./regressionEngine.js";
export type { CompletionCondition, RegressionStep, RegressionResult } from "./regressionEngine.js";

// ─── Script Generator ────────────────────────────────────────────────────────
export { generateScriptWithLLM } from "./scriptGenerator.js";
export type { GenerateScriptResult } from "./scriptGenerator.js";

// ─── Flow & visual review (post-run) ───────────────────────────────────────
export { runHolisticFlowReview } from "./holisticReviewAgent.js";
export type { HolisticReviewInput } from "./holisticReviewAgent.js";
export { runFilmstripReview, capFilmstripFrames } from "./filmstripReview.js";
export type { FilmstripFrame } from "./filmstripReview.js";

// ─── Network Monitor ─────────────────────────────────────────────────────────
export { attachNetworkMonitor } from "./networkMonitor.js";
export type { NetworkMonitorResult } from "./networkMonitor.js";

// ─── Bug Enrichment ──────────────────────────────────────────────────────────
export { enrichBugsForRun } from "./bugEnrichment.js";
export { runBugTriageAgent } from "./bugTriageAgent.js";
export type { BugTriageInput, BugTriageResult } from "./bugTriageAgent.js";

// ─── Bug screenshot markup (red box on saved JPEGs) ───────────────────────────
export { drawRedBoundingBoxOnJpeg } from "./bugScreenshotMarkup.js";
export type { BugRegion } from "./bugScreenshotMarkup.js";

// ─── Run Events ──────────────────────────────────────────────────────────────
export { createEmitter, getEmitter, destroyEmitter, requestStop, isStopRequested } from "./runEvents.js";

// ─── Live run snapshot (Redis + Run Detail hydrate) ───────────────────────────
export {
  LIVE_PREVIEW_FILENAME,
  liveRunRedisKey,
  emptyLiveRunSnapshot,
  applyLiveRunEvent,
  parseLiveRunSnapshot,
} from "./liveRunSnapshot.js";
export type { LiveRunSnapshot, LiveActivityEntry, LiveRunReduceEvent } from "./liveRunSnapshot.js";

// ─── Crawler ─────────────────────────────────────────────────────────────────
export { runCrawl, executeCrawlRun, generateIntentForNode } from "./crawlerWorker.js";
export type {
  CrawlPageData, CrawlResult, CrawlSuggestedFlow, CrawlLlmCostBreakdown, CrawlMetadata,
  CrawlProgressPhase, CrawlProgressMetadata, CrawlProgressSnapshot, RunCrawlOptions,
} from "./crawlerWorker.js";

// ─── Run Orchestrator ────────────────────────────────────────────────────────
export { runOrchestratedJob } from "./runOrchestrator.js";
export type { RunJob, RunResult } from "./runOrchestrator.js";
