export * from "./types.js";

import type {
  Project, Environment, TestRun, Bug, SavedTest,
  AppTreeDestination, CrawlRun, CoverageStats, OverviewStats,
  RunStreamEvent,
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
    this.apiUrl = (options.apiUrl ?? "http://localhost:19833").replace(/\/$/, "");
    this.webUrl = (options.webUrl ?? "http://localhost:19834").replace(/\/$/, "");
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

  // ── Scanning ─────────────────────────────────────────────────────────

  async startScan(projectId: string): Promise<void> {
    await this.fetch(`/api/projects/${projectId}/scan`, { method: "POST" });
  }

  async getScanStatus(projectId: string): Promise<CrawlRun | null> {
    const data = await this.fetch<{ scan: CrawlRun | null }>(
      `/api/projects/${projectId}/scan/status`,
    );
    return data.scan;
  }

  /**
   * Trigger a scan and wait for it to complete.
   * Polls every 3 seconds, times out after `timeoutMs` (default 5 minutes).
   */
  async waitForScan(projectId: string, timeoutMs = 300_000): Promise<CrawlRun> {
    await this.startScan(projectId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3_000);
      const status = await this.getScanStatus(projectId);
      if (status && status.status !== "running") return status;
    }
    throw new Error("Scan timed out");
  }

  // ── Runs ─────────────────────────────────────────────────────────────

  async startRun(
    projectId: string,
    params: {
      environmentId: string;
      intent?: string;
      testId?: string;
      destinationId?: string;
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

  async getPages(projectId: string): Promise<{ pages: AppTreeDestination[]; coverage: CoverageStats }> {
    return this.fetch(`/api/projects/${projectId}/pages`);
  }

  async getCoverage(projectId: string): Promise<CoverageStats> {
    return this.fetch(`/api/projects/${projectId}/coverage`);
  }

  async getOverview(projectId: string): Promise<OverviewStats> {
    return this.fetch(`/api/projects/${projectId}/overview`);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
