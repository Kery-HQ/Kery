export * from "./types.js";

import type {
  Project, Environment, TestRun, Bug, SavedTest, TestGroup,
  OverviewStats,
  RunStreamEvent,
  ConnectionAuditResult,
} from "./types.js";

export interface KeryClientOptions {
  apiUrl?: string;
  webUrl?: string;
  apiKey?: string;
}

export class KeryClient {
  readonly apiUrl: string;
  readonly webUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: KeryClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? "http://localhost:11111").replace(/\/$/, "");
    this.webUrl = (options.webUrl ?? "http://localhost:11111").replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async fetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const h = new Headers(init.headers as HeadersInit);
    const body = init.body;
    if (typeof body === "string" && body.length > 0 && !h.has("Content-Type")) {
      h.set("Content-Type", "application/json");
    }
    if (this.apiKey) {
      h.set("Authorization", `Bearer ${this.apiKey}`);
    }
    const res = await fetch(`${this.apiUrl}${path}`, { ...init, headers: h });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kery API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  /** Construct a full web UI URL. */
  buildWebUrl(path: string): string {
    return `${this.webUrl}${path}`;
  }

  // ── Health ───────────────────────────────────────────────────────────

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Projects ─────────────────────────────────────────────────────────

  async listProjects(): Promise<Project[]> {
    const data = await this.fetch<{ projects: Project[] }>("/api/projects");
    return data.projects;
  }

  async createProject(name: string, domain?: string): Promise<Project> {
    const data = await this.fetch<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, domain: domain || undefined }),
    });
    return data.project;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}`, { method: "DELETE" });
  }

  // ── Environments ─────────────────────────────────────────────────────

  async listEnvironments(projectId: string): Promise<Environment[]> {
    const data = await this.fetch<{ environments: Environment[] }>(
      `/api/projects/${projectId}/environments`,
    );
    return data.environments;
  }

  async createEnvironment(
    projectId: string,
    name: string,
    baseUrl: string,
    isDefault = false,
  ): Promise<Environment> {
    const data = await this.fetch<{ environment: Environment }>(
      `/api/projects/${projectId}/environments`,
      { method: "POST", body: JSON.stringify({ name, baseUrl, isDefault }) },
    );
    return data.environment;
  }

  async getDefaultEnvironment(projectId: string): Promise<Environment> {
    const envs = await this.listEnvironments(projectId);
    const def = envs.find((e) => e.is_default) ?? envs[0];
    if (!def) throw new Error("No environments configured for this project");
    return def;
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  async setAuth(
    projectId: string,
    environmentId: string,
    mode: string,
    config?: Record<string, unknown>,
  ): Promise<void> {
    await this.fetch(
      `/api/projects/${projectId}/environments/${environmentId}/auth`,
      { method: "POST", body: JSON.stringify({ mode, config }) },
    );
  }

  // ── Runs ─────────────────────────────────────────────────────────────

  async startRun(
    projectId: string,
    params: {
      environmentId: string;
      intent?: string;
      testId?: string;
    },
  ): Promise<{ runId: string }> {
    const data = await this.fetch<{ runId: string }>(
      `/api/projects/${projectId}/run`,
      { method: "POST", body: JSON.stringify(params) },
    );
    return data;
  }

  async getRun(runId: string): Promise<TestRun> {
    const data = await this.fetch<{ run: TestRun }>(`/api/runs/${runId}`);
    return data.run;
  }

  async listRuns(projectId: string): Promise<TestRun[]> {
    const data = await this.fetch<{ runs: TestRun[] }>(
      `/api/projects/${projectId}/runs`,
    );
    return data.runs;
  }

  /**
   * Wait for a run to complete.
   * Tries SSE stream first, falls back to polling every 5 seconds.
   */
  async waitForRun(runId: string, timeoutMs = 900_000): Promise<TestRun> {
    try {
      return await this.waitForRunViaSSE(runId, timeoutMs);
    } catch {
      return await this.waitForRunViaPolling(runId, timeoutMs);
    }
  }

  private async waitForRunViaSSE(runId: string, timeoutMs: number): Promise<TestRun> {
    const url = `${this.apiUrl}/api/runs/${runId}/stream`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) throw new Error("SSE connection failed");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try {
          const event = JSON.parse(json) as RunStreamEvent;
          if (event.type === "done") {
            reader.cancel();
            return event.run;
          }
          if (event.type === "error") {
            reader.cancel();
            throw new Error(event.message);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== "SSE connection failed") throw e;
        }
      }
    }
    // SSE ended without done event — fall back to fetch
    return this.getRun(runId);
  }

  private async waitForRunViaPolling(runId: string, timeoutMs: number): Promise<TestRun> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      if (run.status !== "queued" && run.status !== "running") return run;
      await sleep(5_000);
    }
    throw new Error("Run timed out");
  }

  // ── Bugs ─────────────────────────────────────────────────────────────

  async getBugs(projectId: string): Promise<Bug[]> {
    const data = await this.fetch<{ bugs: Bug[] }>(
      `/api/projects/${projectId}/bugs`,
    );
    return data.bugs;
  }

  // ── Pages & Coverage ─────────────────────────────────────────────────

  async getOverview(projectId: string): Promise<OverviewStats> {
    return this.fetch(`/api/projects/${projectId}/overview`);
  }

  // ── Project management ───────────────────────────────────────────────────

  async updateProject(
    projectId: string,
    data: { name?: string; domain?: string | null },
  ): Promise<Project> {
    const result = await this.fetch<{ project: Project }>(`/api/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return result.project;
  }

  // ── Environment management ───────────────────────────────────────────────

  async updateEnvironment(
    projectId: string,
    environmentId: string,
    data: { name?: string; baseUrl?: string },
  ): Promise<Environment> {
    const result = await this.fetch<{ environment: Environment }>(
      `/api/projects/${projectId}/environments/${environmentId}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
    return result.environment;
  }

  async deleteEnvironment(projectId: string, environmentId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/environments/${environmentId}`, {
      method: "DELETE",
    });
  }

  async testConnection(projectId: string, environmentId: string, baseUrl?: string): Promise<ConnectionAuditResult> {
    const result = await this.fetch<{ audit: ConnectionAuditResult }>(
      `/api/projects/${projectId}/environments/${environmentId}/test-connection`,
      { method: "POST", body: JSON.stringify({ baseUrl }) },
    );
    return result.audit;
  }

  // ── Auth management ──────────────────────────────────────────────────────

  async getAuth(
    projectId: string,
    environmentId: string,
  ): Promise<{ mode: string; config?: Record<string, unknown> } | null> {
    const result = await this.fetch<{
      auth: { mode: string; config?: Record<string, unknown> } | null;
    }>(`/api/projects/${projectId}/environments/${environmentId}/auth`);
    return result.auth;
  }

  // ── Bug management ───────────────────────────────────────────────────────

  async updateBug(
    projectId: string,
    bugId: string,
    status: "open" | "in_progress" | "resolved" | "wont_fix",
  ): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/bugs/${bugId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  async deleteBug(projectId: string, bugId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/bugs/${bugId}`, { method: "DELETE" });
  }

  // ── Pages ─────────────────────────────────────────────────────────────────

  async updatePage(projectId: string, pageId: string, enabled: boolean): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async stopRun(runId: string): Promise<void> {
    await this.fetch(`/api/runs/${runId}/stop`, { method: "POST" });
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async listMemory(projectId: string): Promise<Record<string, unknown>[]> {
    const result = await this.fetch<{ entries: Record<string, unknown>[] }>(
      `/api/projects/${projectId}/memory`,
    );
    return result.entries;
  }

  async createMemoryEntry(
    projectId: string,
    data: {
      type: string;
      summary: string;
      content: string;
      confidence?: number;
      region?: { description: string } | null;
    },
  ): Promise<Record<string, unknown>> {
    const result = await this.fetch<{ entry: Record<string, unknown> }>(
      `/api/projects/${projectId}/memory`,
      { method: "POST", body: JSON.stringify(data) },
    );
    return result.entry;
  }

  async updateMemoryEntry(
    projectId: string,
    entryId: string,
    data: {
      type?: string;
      summary?: string;
      content?: string;
      confidence?: number;
      region?: { description: string } | null;
    },
  ): Promise<Record<string, unknown>> {
    const result = await this.fetch<{ entry: Record<string, unknown> }>(
      `/api/projects/${projectId}/memory/${entryId}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
    return result.entry;
  }

  async deleteMemoryEntry(projectId: string, entryId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/memory/${entryId}`, { method: "DELETE" });
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getModelSettings(): Promise<{
    models: Record<string, { current: string; default: string; customized: boolean }>;
    modelPrices?: Record<string, { input: number; output: number }>;
    llmKeys?: Record<string, boolean>;
  }> {
    return this.fetch("/api/settings/models");
  }

  async updateModelSettings(
    models: Partial<Record<"agentModel" | "auxiliaryModel" | "reviewAgentModel" | "stagehandModel", string>>,
  ): Promise<void> {
    await this.fetch("/api/settings/models", { method: "PUT", body: JSON.stringify(models) });
  }

  async getApiKeys(): Promise<
    Record<string, { hasKey: boolean; source: "env" | "db" | "none"; maskedKey?: string }>
  > {
    return this.fetch("/api/settings/api-keys");
  }

  async updateApiKeys(
    keys: Partial<Record<"openai" | "anthropic" | "gemini" | "openrouter", string>>,
  ): Promise<void> {
    await this.fetch("/api/settings/api-keys", { method: "PUT", body: JSON.stringify(keys) });
  }

  // ── Flow discovery ───────────────────────────────────────────────────

  async discoverFlows(
    projectId: string,
    environmentId: string,
  ): Promise<{ runId: string; alreadyRunning: boolean }> {
    return this.fetch(`/api/projects/${projectId}/discover-flows`, {
      method: "POST",
      body: JSON.stringify({ environmentId }),
    });
  }

  async getDiscoveryStatus(
    projectId: string,
  ): Promise<{ active: boolean; runId?: string; status?: string }> {
    return this.fetch(`/api/projects/${projectId}/discover-flows/status`);
  }

  async getDiscoveredFlows(
    runId: string,
  ): Promise<{ id: string; name: string; intent: string; context?: string | null; created_at: string }[]> {
    const data = await this.fetch<{ flows: { id: string; name: string; intent: string; context?: string | null; created_at: string }[] }>(
      `/api/runs/${runId}/discovered-flows`,
    );
    return data.flows;
  }

  // ── Test Groups ──────────────────────────────────────────────────────

  async listGroupsWithTests(projectId: string): Promise<{ groups: TestGroup[]; tests: SavedTest[] }> {
    return this.fetch(`/api/projects/${projectId}/groups`);
  }

  async createGroup(projectId: string, name: string): Promise<TestGroup> {
    const data = await this.fetch<{ group: TestGroup }>(`/api/projects/${projectId}/groups`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return data.group;
  }

  async renameGroup(projectId: string, groupId: string, name: string): Promise<TestGroup> {
    const data = await this.fetch<{ group: TestGroup }>(`/api/projects/${projectId}/groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    return data.group;
  }

  async deleteGroup(projectId: string, groupId: string, deleteTests: boolean): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/groups/${groupId}`, {
      method: "DELETE",
      body: JSON.stringify({ deleteTests }),
    });
  }

  async moveTest(projectId: string, testId: string, groupId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/tests/${testId}/group`, {
      method: "PATCH",
      body: JSON.stringify({ groupId }),
    });
  }

  // ── Saved Tests ──────────────────────────────────────────────────────

  async listTests(projectId: string): Promise<SavedTest[]> {
    const data = await this.fetch<{ tests: SavedTest[] }>(
      `/api/projects/${projectId}/tests`,
    );
    return data.tests;
  }

  async createTest(
    projectId: string,
    name: string,
    intent: string,
    context?: string,
  ): Promise<SavedTest> {
    const data = await this.fetch<{ test: SavedTest }>(
      `/api/projects/${projectId}/tests`,
      { method: "POST", body: JSON.stringify({ name, intent, context }) },
    );
    return data.test;
  }

  async updateTest(
    projectId: string,
    testId: string,
    data: {
      name?: string;
      intent?: string;
      context?: string | null;
      reset_script?: boolean;
    },
  ): Promise<SavedTest> {
    const result = await this.fetch<{ test: SavedTest }>(
      `/api/projects/${projectId}/tests/${testId}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
    return result.test;
  }

  async deleteTest(projectId: string, testId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/tests/${testId}`, { method: "DELETE" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
