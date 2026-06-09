import type { MemoryEntry, MemoryEntryInsert } from "./agentMemory.js";
import type { Bug } from "./types.js";

export interface StorageAdapter {
  // Memory
  loadProjectMemory(projectId: string): Promise<MemoryEntry[]>;
  saveProjectMemoryEntries(projectId: string, entries: MemoryEntryInsert[]): Promise<void>;
  boostConfidence(ids: string[], amount?: number): Promise<void>;
  deleteMemoryEntries(ids: string[]): Promise<void>;
  updateMemoryEntry(
    id: string,
    data: { summary?: string; content?: string; confidence?: number },
  ): Promise<void>;

  // Bugs
  persistBugsFromRun(
    projectId: string,
    runId: string,
    runLabel: string | null,
    reportedAt: string,
    environmentId: string | null,
    environmentName: string | null,
    enrichedBugs: Bug[],
  ): Promise<{ inserted: number; skipped: number; insertedBugs: Array<{ id: string; screenshotPath: string | null }> }>;
  updateBugScreenshotPath(bugId: string, newPath: string): Promise<void>;
  listBugs(projectId: string): Promise<Bug[]>;
  getBugScreenshot(bugId: string): Promise<string | null>;

  // Runs
  getTestRun(runId: string): Promise<any>;
  updateTestRun(runId: string, data: Record<string, any>): Promise<void>;
  createTestRun(data: Record<string, any>): Promise<any>;
  /** Incrementally append steps mid-run (crash-safe persistence). */
  appendRunSteps(runId: string, steps: any[]): Promise<void>;
  /** Incrementally append LLM calls mid-run (crash-safe persistence). */
  appendRunLlmCalls(runId: string, calls: any[]): Promise<void>;

  // Path generator needs
  getOpenBugs(projectId: string, limit: number): Promise<any[]>;

  // Regression plans
  getRegressionPlan(table: string, id: string): Promise<any>;
  updateRegressionPlan(table: string, id: string, data: Record<string, any>): Promise<void>;

  // Crawl
  getExistingTestNames(projectId: string): Promise<string[]>;
  getAuthConfig(projectId: string, environmentId: string): Promise<any>;

  // Saved tests
  getSavedTest(id: string): Promise<any>;
  updateSavedTest(id: string, data: Record<string, any>): Promise<void>;

  // Global settings
  getSettings(): Promise<Record<string, string>>;
  saveSetting(key: string, value: string): Promise<void>;
  deleteSettings(keys: string[]): Promise<void>;

  // Transaction support
  withTransaction<T>(fn: (txStorage: StorageAdapter) => Promise<T>): Promise<T>;

  // Raw pool access (typed alternative to `(storage as any).pool`)
  getPool(): unknown;
}
