/**
 * In-memory StorageAdapter for the local benchmark harness.
 *
 * Lets the real engine run end-to-end against a locally served app with no
 * Postgres, no queue and no cloud — so an engine change can be measured in
 * minutes instead of a deploy cycle. Deliberately faithful to the interface
 * rather than clever: every method the orchestrator touches is implemented.
 */
export function createMemoryStorage() {
  const runs = new Map();
  const bugs = [];
  let memory = [];

  const storage = {
    // ── Memory ──────────────────────────────────────────────────────────────
    async loadProjectMemory() { return memory; },
    async saveProjectMemoryEntries(_projectId, entries) {
      memory = memory.concat(
        entries.map((e, i) => ({
          id: `mem-${memory.length + i}`,
          scope: "project",
          type: e.type ?? "tip",
          summary: e.summary ?? "",
          content: e.content ?? "",
          source: e.source ?? "agent",
          confidence: e.confidence ?? 50,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
      );
    },
    async boostConfidence() {},
    async deleteMemoryEntries(ids) { memory = memory.filter((m) => !ids.includes(m.id)); },
    async updateMemoryEntry() {},

    // ── Bugs ────────────────────────────────────────────────────────────────
    async persistBugsFromRun(_p, runId, _l, _at, _eid, _ename, enriched) {
      const inserted = enriched.map((b, i) => ({ id: `bug-${bugs.length + i}`, screenshotPath: b.screenshotPath ?? null }));
      enriched.forEach((b) => bugs.push({ ...b, run_id: runId }));
      return { inserted: enriched.length, skipped: 0, insertedBugs: inserted };
    },
    async updateBugScreenshotPath() {},
    async listBugs() { return bugs; },
    async getBugScreenshot() { return null; },

    // ── Runs ────────────────────────────────────────────────────────────────
    async getTestRun(runId) { return runs.get(runId) ?? null; },
    async updateTestRun(runId, data) { runs.set(runId, { ...(runs.get(runId) ?? { id: runId }), ...data }); },
    async createTestRun(data) {
      const id = data.id ?? `run-${runs.size + 1}`;
      runs.set(id, { id, ...data });
      return { id, ...data };
    },
    async appendRunSteps() {},
    async appendRunLlmCalls() {},

    // ── Everything else the orchestrator may reach for ──────────────────────
    async getOpenBugs() { return []; },
    async getRegressionPlan() { return null; },
    async updateRegressionPlan() {},
    async getExistingTests() { return []; },
    async getAuthConfig() { return null; },
    async getSavedTest() { return null; },
    async createSavedTest(data) { return { id: `test-${Date.now()}`, ...data }; },
    async updateSavedTest() {},
    async ensureAutoScanGroup() { return "group-auto"; },
    async getSettings() { return {}; },
    async saveSetting() {},
    async deleteSettings() {},
    async withTransaction(fn) { return fn(storage); },

    // Harness accessors
    _dump() { return { runs: [...runs.values()], bugs, memory }; },
    _clearMemory() { memory = []; },
  };
  return storage;
}
