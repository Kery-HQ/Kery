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

/** Result of checking whether Kery can reach an environment URL. */
export type ConnectionAuditResult = {
  status: "ok" | "warning" | "failed";
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
  trigger_type: string;
  trigger_ref: string;
  status: "queued" | "running" | "passed" | "failed";
  summary?: string | null;
  /** Resolved in list queries: flow name, page title/route, or adhoc label. */
  display_name?: string | null;
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

export type AgentPlanItem = {
  text: string;
  status: "pending" | "done" | "current" | "failed";
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
  url?: string | null;
  runId: string;
  runLabel?: string | null;
  reportedAt: string;
  environment?: string | null;
  index?: number;
  source?: "navigator" | "review" | "filmstrip";
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
  group_id?: string | null;
  created_at: string;
};

/** A test group (folder). */
export type TestGroup = {
  id: string;
  project_id: string;
  name: string;
  is_default: boolean;
  is_auto_scan: boolean;
  test_count: number;
  created_at: string;
};

/** Project overview statistics. */
export type OverviewStats = {
  totalRuns: number;
  passRate: number;
  passed: number;
  failed: number;
  running: number;
  /** Sum of test run LLM costs (USD). */
  totalCostUsd: number;
};

/** SSE event from run stream. */
export type RunStreamEvent =
  | { type: "step"; step: RunStep }
  | { type: "plan"; items: AgentPlanItem[]; at: number }
  | { type: "activity"; activity: { kind: "observe"; text: string; at: number } }
  | { type: "screenshot"; data: string }
  | { type: "llm_call"; call: LLMCallRecord }
  | { type: "done"; run: TestRun }
  | { type: "error"; message: string };
