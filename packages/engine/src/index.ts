// ─── Docker Host ────────────────────────────────────────────────────────────
export { rewriteForDocker } from "./dockerHost.js";

// ─── Config ──────────────────────────────────────────────────────────────────
export { initEngineConfig, getConfig, updateEngineConfig, type EngineConfig } from "./config.js";
export { logger } from "./logger.js";

// ─── Storage ─────────────────────────────────────────────────────────────────
export type { StorageAdapter } from "./storage.js";

// ─── Types ───────────────────────────────────────────────────────────────────
export * from "./types.js";

// ─── Agent ───────────────────────────────────────────────────────────────────
export { runAgent, handleAuth, waitForPageStable, executeAction } from "./agent.js";
export type { AgentAction, RunStep, LLMCallRecord, AgentResult, LLMAgentType } from "./agent.js";

// ─── Token Auth (Clerk, Supabase) ────────────────────────────────────────────
export { handleTokenAuth, authenticateWithClerk, authenticateWithSupabase } from "./tokenAuth.js";

// ─── Memory ──────────────────────────────────────────────────────────────────
export {
  loadProjectMemory, loadPageMemory,
  saveProjectMemoryEntries, savePageMemoryEntries,
  formatMemoryForPrompt, proposeMemoriesFromRun, boostConfidence,
} from "./agentMemory.js";
export type { MemoryEntry, MemoryEntryInsert, MemoryEntryType, MemorySource } from "./agentMemory.js";

// ─── LLM ─────────────────────────────────────────────────────────────────────
export { llmChat, llmAgentChat, llmSummarize, llmReviewAnalysis, llmPathPlan, calcCostUsd, getLLMBase, MAX_OUTPUT_TOKENS } from "./llmClient.js";
export type { LLMUsage } from "./llmClient.js";

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

// ─── Path Generator ──────────────────────────────────────────────────────────
export { generateTestPlan, formatTestPlanForNavigator } from "./pathGenerator.js";
export type { PathGeneratorInput, GenerateTestPlanResult } from "./pathGenerator.js";

// ─── Review Agent ────────────────────────────────────────────────────────────
export { createReviewProcessor } from "./reviewAgent.js";
export type { ReviewRequest, ReviewProcessor } from "./reviewAgent.js";

// ─── Network Monitor ─────────────────────────────────────────────────────────
export { attachNetworkMonitor } from "./networkMonitor.js";
export type { NetworkMonitorResult } from "./networkMonitor.js";

// ─── Bug Enrichment ──────────────────────────────────────────────────────────
export { enrichBugsForRun } from "./bugEnrichment.js";

// ─── Summarizer ──────────────────────────────────────────────────────────────
export { summarizeRun } from "./summarizer.js";
export type { SummarizeInput, SummarizeResult } from "./summarizer.js";

// ─── Run Events ──────────────────────────────────────────────────────────────
export { createEmitter, getEmitter, destroyEmitter, requestStop, isStopRequested } from "./runEvents.js";

// ─── Crawler ─────────────────────────────────────────────────────────────────
export { runCrawl, executeCrawlRun, generateIntentForNode } from "./crawlerWorker.js";
export type { CrawlPageData, CrawlResult, CrawlSuggestedFlow } from "./crawlerWorker.js";

// ─── Run Orchestrator ────────────────────────────────────────────────────────
export { runOrchestratedJob } from "./runOrchestrator.js";
export type { RunJob, RunResult } from "./runOrchestrator.js";
