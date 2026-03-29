/** Kery project. */
export type Project = {
  id: string;
  name: string;
  domain?: string | null;
};

/** Testing environment (base URL + auth). */
export type Environment = {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  is_default: boolean;
};

/** Auth configuration for an environment. */
export type AuthConfig = {
  mode: "ui" | "apiToken" | "oauthToken" | "tokenProvider" | "none";
  config?: Record<string, unknown>;
};

/** A test run execution. */
export type TestRun = {
  id: string;
  project_id: string;
  environment_id: string;
  test_id?: string | null;
  destination_id?: string | null;
  trigger_type: string;
  trigger_ref: string;
  status: "queued" | "running" | "passed" | "failed" | "partial";
  summary?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps_json?: RunStep[] | null;
  bugs_json?: Bug[] | null;
  llm_calls_json?: LLMCallRecord[] | null;
};

/** A single step within a test run. */
export type RunStep = {
  index: number;
  action: string;
  target?: string;
  value?: string;
  reasoning?: string;
  status: "ok" | "failed" | "skipped";
  url?: string;
  bugType?: string;
  severity?: string;
  source?: string;
};

/** A bug found during testing. */
export type Bug = {
  id?: string;
  name: string;
  description: string;
  category: "visual" | "functional" | "ux" | "other";
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  /** JPEG filename under run screenshot dir (bytes on disk). */
  screenshotPath?: string | null;
  screenshotBase64?: string | null;
  stepsToReproduce: string[];
  url?: string | null;
  runId: string;
  runLabel?: string | null;
  reportedAt: string;
  environment?: string | null;
  index?: number;
  source?: "navigator" | "review" | "pathgen" | "filmstrip";
  /** Bounding box when provided by review/filmstrip (also burned into screenshot file). */
  region?: { x: number; y: number; w: number; h: number };
};

/** An LLM call record for cost tracking. */
export type LLMCallRecord = {
  model: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  vision?: boolean;
};

/** A saved/reusable test definition. */
export type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  created_at: string;
};

/** A discovered page/route in the app. */
export type AppTreeDestination = {
  id: string;
  project_id: string;
  normalized_route: string;
  title: string;
  health_status: "clean" | "issues" | "stale" | "untested";
  issues_count: number;
  last_inspected_at: string | null;
  last_crawled_at: string;
};

/** A crawl/scan run. */
export type CrawlRun = {
  id: string;
  project_id: string;
  environment_id: string;
  status: "running" | "completed" | "failed";
  pages_visited: number | null;
  nodes_found: number | null;
  destinations_built: number | null;
  started_at: string;
  completed_at: string | null;
};

/** Coverage statistics for a project. */
export type CoverageStats = {
  total: number;
  tested: number;
  clean: number;
  withIssues: number;
  stale: number;
  untested: number;
};

/** Project overview statistics. */
export type OverviewStats = {
  totalRuns: number;
  passRate: number;
  passed: number;
  failed: number;
  running: number;
};

/** SSE event from run stream. */
export type RunStreamEvent =
  | { type: "step"; step: RunStep }
  | { type: "screenshot"; data: string }
  | { type: "llm_call"; call: LLMCallRecord }
  | { type: "done"; run: TestRun }
  | { type: "error"; message: string };
