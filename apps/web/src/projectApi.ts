const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:19833";

async function apiFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const h = new Headers(init.headers as HeadersInit);
  const body = init.body;
  if (typeof body === "string" && body.length > 0 && !h.has("Content-Type")) {
    h.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers: h });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Projects ---

export async function fetchProjects() {
  return apiFetch(`${API_BASE}/api/projects`);
}

export async function createProject(name: string, domain?: string | null) {
  return apiFetch(`${API_BASE}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name, domain: domain?.trim() || undefined }),
  });
}

export async function updateProject(projectId: string, name: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}`, { method: "DELETE" });
}

// --- Project overview / runs ---

export async function fetchProjectOverview(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/overview`);
}

export async function fetchProjectRuns(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/runs`);
}

export async function fetchProjectBugs(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/bugs`);
}

// --- Environments ---

export async function fetchEnvironments(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments`);
}

export async function createEnvironment(projectId: string, payload: { name: string; baseUrl: string; isDefault?: boolean }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateEnvironment(
  projectId: string,
  environmentId: string,
  payload: { name?: string; baseUrl?: string },
) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments/${environmentId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteEnvironment(projectId: string, environmentId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments/${environmentId}`, { method: "DELETE" });
}

// --- Auth config ---

export async function fetchAuth(projectId: string, environmentId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments/${environmentId}/auth`);
}

export async function saveAuth(projectId: string, environmentId: string, mode: string, config: any) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/environments/${environmentId}/auth`, {
    method: "POST",
    body: JSON.stringify({ mode, config }),
  });
}

// --- Runs ---

export async function runProjectTest(projectId: string, environmentId: string, intent: string, testId?: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/run`, {
    method: "POST",
    body: JSON.stringify({ environmentId, ...(testId ? { testId } : { intent }) }),
  });
}

export async function fetchRun(runId: string) {
  return apiFetch(`${API_BASE}/api/runs/${runId}`);
}

/** Returns the SSE stream URL (no auth token needed for OSS). */
export function getRunStreamUrl(runId: string): string {
  return `${API_BASE}/api/runs/${runId}/stream`;
}

export async function stopRun(runId: string) {
  return apiFetch(`${API_BASE}/api/runs/${runId}/stop`, { method: "POST", body: JSON.stringify({}) });
}

export async function fetchRunBugs(runId: string) {
  return apiFetch(`${API_BASE}/api/runs/${runId}/bugs`);
}

// --- Memory (semantic) ---

export type MemoryEntryType = "learned_path" | "ignore_region" | "avoid_region" | "bug_pattern" | "tip";

export type MemoryEntry = {
  id: string;
  scope: "project" | "page";
  project_id: string | null;
  destination_id: string | null;
  type: MemoryEntryType;
  summary: string;
  content: string;
  region?: { description: string } | null;
  source: "agent" | "user";
  confidence: number;
  created_at: string;
  updated_at: string;
};

export async function fetchMemory(projectId: string): Promise<{ entries: MemoryEntry[] }> {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory`);
}

export async function createMemoryEntry(
  projectId: string,
  entry: { type: MemoryEntryType; summary: string; content: string; region?: { description: string } | null; confidence?: number },
): Promise<{ entry: MemoryEntry }> {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory`, {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export async function updateMemoryEntry(
  projectId: string,
  entryId: string,
  patch: Partial<Pick<MemoryEntry, "summary" | "content" | "type" | "region" | "confidence">>,
): Promise<{ entry: MemoryEntry }> {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteMemoryEntry(projectId: string, entryId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory/${entryId}`, { method: "DELETE" });
}

export async function clearMemory(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory`, { method: "DELETE" });
}

// --- Page memory ---

export async function fetchPageMemory(projectId: string, destinationId: string): Promise<{ entries: MemoryEntry[] }> {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}/memory`);
}

export async function createPageMemoryEntry(
  projectId: string,
  destinationId: string,
  entry: { type: MemoryEntryType; summary: string; content: string; region?: { description: string } | null; confidence?: number },
): Promise<{ entry: MemoryEntry }> {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}/memory`, {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export async function deletePageMemoryEntry(projectId: string, destinationId: string, entryId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}/memory/${entryId}`, { method: "DELETE" });
}

export async function clearPageMemory(projectId: string, destinationId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}/memory`, { method: "DELETE" });
}

export async function resetPageData(projectId: string, destinationId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}/reset`, { method: "DELETE" });
}

// --- Saved tests ---

export async function fetchTests(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests`);
}

export async function createTest(projectId: string, payload: { name: string; intent: string; context?: string; max_steps?: number }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTest(projectId: string, testId: string, payload: { name?: string; intent?: string; context?: string; max_steps?: number | null }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteTest(projectId: string, testId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}`, { method: "DELETE" });
}

// --- Test memory (uses project memory) ---

export async function fetchTestMemory(projectId: string, _testId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory`);
}

// --- Crawl Discovery ---

export async function triggerCrawl(projectId: string, force = false) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl${force ? "?force=true" : ""}`, { method: "POST" });
}

export async function fetchCrawlRuns(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/runs`);
}

export async function fetchCrawlRun(projectId: string, crawlRunId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/runs/${crawlRunId}`);
}

export async function fetchCrawlNodes(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/nodes`);
}

export async function toggleCrawlNode(projectId: string, nodeId: string, enabled: boolean) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchCrawlSettings(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/settings`);
}

export async function saveCrawlSettings(projectId: string, settings: { crawlEnvironmentId: string | null; autoCrawlWeekly: boolean }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// --- Model settings (global) ---

export type ModelSettingsResponse = {
  models: Record<string, { current: string; default: string; customized: boolean }>;
};

export async function fetchModelSettings(): Promise<ModelSettingsResponse> {
  return apiFetch(`${API_BASE}/api/settings/models`);
}

export async function saveModelSettings(settings: Record<string, string>) {
  return apiFetch(`${API_BASE}/api/settings/models`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function resetModelSettings() {
  return apiFetch(`${API_BASE}/api/settings/models`, { method: "DELETE" });
}

export async function resetCrawlData(projectId: string, deleteFlows = false) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/crawl${deleteFlows ? "?deleteFlows=true" : ""}`, { method: "DELETE" });
}

// --- Pages (unified: replaces Discover + App Tree) ---

export async function fetchPages(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages`);
}

export async function fetchPageDetail(projectId: string, destinationId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${destinationId}`);
}

export async function togglePage(projectId: string, pageId: string, enabled: boolean) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function triggerScan(projectId: string, force = false) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/scan${force ? "?force=true" : ""}`, { method: "POST" });
}

export async function fetchScanStatus(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/scan/status`);
}

export async function fetchEnabledPageIds(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/pages/enabled-ids`);
}

// --- App Tree (legacy) ---

export async function fetchAppTree(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tree`);
}

export async function fetchCoverage(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/coverage`);
}

export async function runDestination(projectId: string, environmentId: string, destinationId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/run`, {
    method: "POST",
    body: JSON.stringify({ environmentId, destinationId }),
  });
}
