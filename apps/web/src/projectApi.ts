const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

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

export async function updateProject(projectId: string, payload: { name?: string; domain?: string | null }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteProject(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}`, { method: "DELETE" });
}

// --- Project overview / runs ---

export async function fetchProjectOverview(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/overview`);
}

export type FetchProjectRunsParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
};

export async function fetchProjectRuns(projectId: string, params: FetchProjectRunsParams = {}) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 0) qs.set("page", String(params.page));
  if (params.pageSize && params.pageSize > 0) qs.set("pageSize", String(params.pageSize));
  if (params.search?.trim()) qs.set("search", params.search.trim());
  if (params.status?.trim()) qs.set("status", params.status.trim());
  const suffix = qs.toString();
  return apiFetch(`${API_BASE}/api/projects/${projectId}/runs${suffix ? `?${suffix}` : ""}`);
}

export async function fetchProjectBugs(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/bugs`);
}

export async function patchProjectBug(
  projectId: string,
  bugId: string,
  patch: { status: "open" | "in_progress" | "resolved" | "wont_fix" },
) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/bugs/${bugId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteProjectBug(projectId: string, bugId: string) {
  return apiFetch<{ ok: boolean; deleted: number }>(
    `${API_BASE}/api/projects/${projectId}/bugs/${bugId}`,
    { method: "DELETE" },
  );
}

export async function deleteAllProjectBugs(projectId: string) {
  return apiFetch<{ ok: boolean; deleted: number }>(
    `${API_BASE}/api/projects/${projectId}/bugs`,
    { method: "DELETE" },
  );
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

export type ConnectionAuditStatus = "ok" | "warning" | "failed";

export type ConnectionAuditResult = {
  status: ConnectionAuditStatus;
  summary: string;
  targetUrl: string;
  runtime: "docker" | "local";
  checkedAt: string;
  checks: Array<{
    name: string;
    status: "passed" | "warning" | "failed" | "skipped";
    message: string;
    details?: Record<string, unknown>;
  }>;
  observations: string[];
  recommendations: string[];
  probe?: {
    url: string;
    hostHeader?: string;
    durationMs: number;
    statusCode?: number;
    location?: string;
    responseSnippet?: string;
    error?: Record<string, unknown>;
  };
};

export async function testEnvironmentConnection(projectId: string, environmentId: string, baseUrl?: string) {
  return apiFetch<{ audit: ConnectionAuditResult }>(
    `${API_BASE}/api/projects/${projectId}/environments/${environmentId}/test-connection`,
    { method: "POST", body: JSON.stringify({ baseUrl }) },
  );
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

export async function runAuthTest(projectId: string, environmentId: string) {
  return apiFetch<{ runId: string; status: string }>(`${API_BASE}/api/projects/${projectId}/run`, {
    method: "POST",
    body: JSON.stringify({
      environmentId,
      authTest: true,
      intent: "Log in using the configured credentials. Once authenticated, stop and report whether the session reached the app.",
    }),
  });
}

export async function runConnectionVerification(projectId: string, environmentId: string) {
  return apiFetch<{ runId: string; status: string }>(`${API_BASE}/api/projects/${projectId}/run`, {
    method: "POST",
    body: JSON.stringify({
      environmentId,
      connectionTest: true,
      intent: "Open the configured app URL, confirm the page loads, then stop.",
    }),
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

export async function deleteRun(runId: string) {
  return apiFetch<{ ok: boolean }>(`${API_BASE}/api/runs/${runId}`, { method: "DELETE" });
}

export async function deleteAllRuns(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/runs`, { method: "DELETE" });
}

export async function fetchRunBugs(runId: string) {
  return apiFetch(`${API_BASE}/api/runs/${runId}/bugs`);
}

// --- Memory (semantic) ---

export type MemoryEntryType = "learned_path" | "ignore_region" | "avoid_region" | "bug_pattern" | "tip";

export type MemoryEntry = {
  id: string;
  project_id: string | null;
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

// --- Saved tests ---

export async function fetchTests(projectId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests`);
}

export async function createTest(projectId: string, payload: { name: string; intent: string; context?: string; max_steps?: number; group_id?: string }) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTest(projectId: string, testId: string, payload: {
  name?: string;
  intent?: string;
  context?: string;
  max_steps?: number | null;
  reset_script?: boolean;
}) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/** Clear the saved replay script for a flow (next run discovers steps again). */
export async function resetTestScript(projectId: string, testId: string) {
  return updateTest(projectId, testId, { reset_script: true });
}

export async function toggleTest(projectId: string, testId: string, enabled: boolean) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteTest(projectId: string, testId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}`, { method: "DELETE" });
}

export async function discoverFlows(projectId: string, environmentId: string) {
  return apiFetch<{ runId: string; alreadyRunning: boolean }>(`${API_BASE}/api/projects/${projectId}/discover-flows`, {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });
}

export async function fetchDiscoveryStatus(projectId: string) {
  return apiFetch<{ active: boolean; runId?: string; status?: string }>(`${API_BASE}/api/projects/${projectId}/discover-flows/status`);
}

export async function fetchDiscoveredFlows(runId: string) {
  return apiFetch<{ flows: { id: string; name: string; intent: string; context?: string | null; created_at: string }[] }>(`${API_BASE}/api/runs/${runId}/discovered-flows`);
}

// --- Test Groups ---

export type TestGroup = {
  id: string;
  project_id: string;
  name: string;
  is_default: boolean;
  is_auto_scan: boolean;
  test_count: number;
  created_at: string;
};

export async function fetchGroups(projectId: string) {
  return apiFetch<{ groups: TestGroup[]; tests: any[] }>(`${API_BASE}/api/projects/${projectId}/groups`);
}

export async function createGroup(projectId: string, name: string) {
  return apiFetch<{ group: TestGroup }>(`${API_BASE}/api/projects/${projectId}/groups`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function renameGroup(projectId: string, groupId: string, name: string) {
  return apiFetch<{ group: TestGroup }>(`${API_BASE}/api/projects/${projectId}/groups/${groupId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

export async function deleteGroup(projectId: string, groupId: string, deleteTests: boolean) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/groups/${groupId}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteTests }),
  });
}

export async function moveTestToGroup(projectId: string, testId: string, groupId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/tests/${testId}/group`, {
    method: "PATCH",
    body: JSON.stringify({ groupId }),
  });
}


// --- Test memory (uses project memory) ---

export async function fetchTestMemory(projectId: string, _testId: string) {
  return apiFetch(`${API_BASE}/api/projects/${projectId}/memory`);
}

// --- Model settings (global) ---

export type LlmKeyPresence = {
  hasOpenRouter: boolean;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  hasGemini: boolean;
};

/** USD per 1M tokens — used for run cost estimates when using a custom model id. */
export type ModelPriceUsd = { input: number; output: number };

export type ModelSlotKey =
  | "agentModel"
  | "auxiliaryModel"
  | "reviewAgentModel";

export type ModelSettingsResponse = {
  models: Record<string, { current: string; default: string; customized: boolean }>;
  llmKeys: LlmKeyPresence;
  modelPrices: Partial<Record<ModelSlotKey, ModelPriceUsd>>;
};

export type SaveModelSettingsPayload = Partial<Record<ModelSlotKey, string>> & {
  modelPrices?: Partial<Record<ModelSlotKey, ModelPriceUsd | null>>;
};

export async function fetchModelSettings(): Promise<ModelSettingsResponse> {
  return apiFetch(`${API_BASE}/api/settings/models`);
}

export async function saveModelSettings(settings: SaveModelSettingsPayload) {
  return apiFetch(`${API_BASE}/api/settings/models`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function resetModelSettings() {
  return apiFetch(`${API_BASE}/api/settings/models`, { method: "DELETE" });
}

// --- Platform settings ---

export type PlatformSettingsResponse = {
  maxConcurrency: number;
  defaultConcurrency: number;
  maxConcurrencyLimit: number;
};

export async function fetchPlatformSettings(): Promise<PlatformSettingsResponse> {
  return apiFetch(`${API_BASE}/api/settings/platform`);
}

export async function savePlatformSettings(settings: { maxConcurrency: number }) {
  return apiFetch(`${API_BASE}/api/settings/platform`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// --- API Key settings ---

export type ApiKeyProvider = "openai" | "anthropic" | "gemini" | "openrouter";

export type ApiKeyInfo = {
  hasKey: boolean;
  /** "db" = saved in database (takes precedence over .env), "env" = from .env only, "none" = not configured. */
  source: "env" | "db" | "none";
  /** Masked hint for DB-stored keys, e.g. "••••••••••••abcd". Not present for env keys. */
  maskedKey?: string;
};

export type ApiKeySettingsResponse = Record<ApiKeyProvider, ApiKeyInfo>;

export async function fetchApiKeySettings(): Promise<ApiKeySettingsResponse> {
  return apiFetch(`${API_BASE}/api/settings/api-keys`);
}

export async function saveApiKeys(keys: Partial<Record<ApiKeyProvider, string>>) {
  return apiFetch(`${API_BASE}/api/settings/api-keys`, {
    method: "PUT",
    body: JSON.stringify(keys),
  });
}

export async function deleteApiKey(provider: ApiKeyProvider) {
  return apiFetch(`${API_BASE}/api/settings/api-keys/${provider}`, { method: "DELETE" });
}
