import type { MemoryEntry, MemoryEntryInsert } from "./agentMemory.js";
import type { Bug } from "./types.js";

export interface StorageAdapter {
  // Memory
  loadProjectMemory(projectId: string): Promise<MemoryEntry[]>;
  loadPageMemory(destinationId: string): Promise<MemoryEntry[]>;
  saveProjectMemoryEntries(projectId: string, entries: MemoryEntryInsert[]): Promise<void>;
  savePageMemoryEntries(destinationId: string, entries: MemoryEntryInsert[]): Promise<void>;
  boostConfidence(ids: string[], amount?: number): Promise<void>;

  // Bugs
  persistBugsFromRun(
    projectId: string,
    runId: string,
    runLabel: string | null,
    reportedAt: string,
    environmentId: string | null,
    environmentName: string | null,
    enrichedBugs: Bug[],
  ): Promise<{ inserted: number; skipped: number }>;
  listBugs(projectId: string): Promise<Bug[]>;

  // Runs
  getTestRun(runId: string): Promise<any>;
  updateTestRun(runId: string, data: Record<string, any>): Promise<void>;
  createTestRun(data: Record<string, any>): Promise<any>;

  // Destinations
  getDestination(id: string): Promise<any>;
  upsertDestinations(projectId: string, destinations: any[]): Promise<void>;

  // Coverage
  getProjectCoverage(projectId: string): Promise<{
    total: number;
    tested: number;
    clean: number;
    withIssues: number;
    stale: number;
    untested: number;
  }>;

  // Path generator needs
  getPastRunsForDestination(destinationId: string, limit: number): Promise<any[]>;
  getOpenBugs(projectId: string, limit: number): Promise<any[]>;

  // Regression plans
  getRegressionPlan(table: string, id: string): Promise<any>;
  updateRegressionPlan(table: string, id: string, data: Record<string, any>): Promise<void>;

  // Crawl
  getCrawlEnvironment(projectId: string, environmentId: string): Promise<any>;
  createCrawlRun(data: Record<string, any>): Promise<any>;
  updateCrawlRun(id: string, data: Record<string, any>): Promise<void>;
  getExistingTestNames(projectId: string): Promise<string[]>;
  getAuthConfig(projectId: string, environmentId: string): Promise<any>;
  buildAppTree(projectId: string, crawlRunId: string, sitemap: any[]): Promise<any>;
  upsertCrawlNodes(projectId: string, crawlRunId: string, result: any): Promise<void>;

  // Run coverage tracking
  upsertRunCoverage(runId: string, destinationId: string, bugsFound: number): Promise<void>;
  updateDestinationHealth(destinationId: string, data: Record<string, any>): Promise<void>;

  // Saved tests
  getSavedTest(id: string): Promise<any>;
  updateSavedTest(id: string, data: Record<string, any>): Promise<void>;

  // Global settings
  getSettings(): Promise<Record<string, string>>;
  saveSetting(key: string, value: string): Promise<void>;
  deleteSettings(keys: string[]): Promise<void>;

  // Transaction support
  withTransaction<T>(fn: (txStorage: StorageAdapter) => Promise<T>): Promise<T>;
}
