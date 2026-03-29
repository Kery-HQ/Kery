export type AuthConfig = {
  mode: "ui" | "apiToken" | "oauthToken" | "tokenProvider";
  loginUrl?: string;
  selectors?: {
    usernameField?: string;
    passwordField?: string;
    submitButton?: string;
  };
  credentials?: {
    username?: string;
    password?: string;
  };
  /** TOTP secret for 2FA/MFA (base32-encoded). Used to generate one-time codes. */
  totp_secret?: string;
  tokenProvider?: {
    type: "supabase" | "clerk" | "custom";
    apiUrl: string;
    apiKey: string;
    credentials?: {
      email: string;
      password: string;
    };
    appDomain?: string;
    refreshToken?: string;
  };
  apiTokenConfig?: {
    token: string;
    headerName?: string;  // Default: "Authorization"
    headerPrefix?: string; // Default: "Bearer"
  };
  oauthProvider?: {
    name: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
};

export type Project = {
  id: string;
  name: string;
  domain?: string | null;
};

export type Environment = {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  is_default: boolean;
};

export type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  created_at: string;
};

export type TestRun = {
  id: string;
  project_id: string;
  repo_id: string;
  environment_id: string;
  test_id?: string | null;
  trigger_type: string;
  trigger_ref: string;
  status: "queued" | "running" | "passed" | "failed" | "partial";
  summary?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  bugs_json?: Bug[] | null;
};

// ─── App Tree ─────────────────────────────────────────────────────────────────

export type AppTreeDestination = {
  id: string;
  project_id: string;
  normalized_route: string;
  title: string;
  forms_json: AppTreeForm[];
  buttons_json: AppTreeButton[];
  interactions_json: AppTreeInteraction[];
  nav_links: string[];
  health_status: "clean" | "issues" | "stale" | "untested";
  issues_count: number;
  last_inspected_at: string | null;
  last_crawled_at: string;
  crawl_run_id: string | null;
  regression_plan?: any[] | null;
  plan_success_count?: number;
  plan_status?: "none" | "ready" | "stale";
  created_at: string;
  updated_at: string;
};

export type AppTreeForm = {
  id: string;
  fields: AppTreeFormField[];
  submitText: string;
};

export type AppTreeFormField = {
  name: string;
  type: string;
  required: boolean;
  label: string;
  placeholder?: string;
  validationPattern?: string;
  maxLength?: number;
  minLength?: number;
  min?: string;
  max?: string;
  options?: string[];
};

export type AppTreeButton = {
  text: string;
  selector: string;
};

export type AppTreeInteraction = {
  trigger: string;
  revealed: "modal" | "drawer" | "panel" | "unknown";
  fields: string[];
  heading: string;
};

export type AppTreeFlowEdge = {
  id: string;
  project_id: string;
  source_destination_id: string;
  target_destination_id: string;
  trigger_action: string;
  trigger_label: string;
  created_at: string;
};

export type CrawlRun = {
  id: string;
  project_id: string;
  environment_id: string;
  status: "running" | "completed" | "failed";
  trigger_type: "manual" | "webhook" | "scheduled";
  pages_visited: number | null;
  nodes_found: number | null;
  destinations_built: number | null;
  sitemap_json: any;
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
};

/** Source of a bug in multi-agent runs */
export type BugSource = "navigator" | "review" | "pathgen" | "filmstrip";

/** Single step in a path (human-readable target; Navigator resolves to coordinates) */
export type PathStep = {
  action: "navigate" | "click" | "fill" | "assert" | "wait" | "hover" | "scroll" | "pressKey" | "selectOption" | "back";
  target: string;
  value?: string;
  expectation?: string;
  reasoning: string;
};

/** Test plan produced by the Path Generator for the Navigator to execute */
export type TestPlan = {
  happyPaths: PathStep[][];
  sadPaths: PathStep[][];
  edgeCases: PathStep[][];
  interactionFlows: PathStep[][];
  regressionChecks: PathStep[][];
  authFlows: PathStep[][];
  dataIntegrity: PathStep[][];
  boundaryValues: PathStep[][];
  crossPageFlows: PathStep[][];
};

/** Bug categories from the Review / Filmstrip agents (aligned with review prompt output) */
export type ReviewBug = {
  source: "review" | "filmstrip";
  stepIndex: number;
  type: "visual" | "ux" | "behavioral" | "a11y" | "performance" | "data";
  description: string;
  severity: "low" | "medium" | "high";
  /** Optional bounding box (0-1000 coords or pixels) */
  region?: { x: number; y: number; w: number; h: number };
  at?: number;
  /** Filmstrip: screenshot to attach when stepIndex does not map to per-step review queue */
  screenshotBase64?: string;
};

/** Network/console bug from the Network Monitor agent */
export type NetworkBug = {
  source: "network";
  stepIndex?: number;
  type: "http_error" | "request_failed" | "console_error" | "cors" | "slow_response";
  description: string;
  severity: "low" | "medium" | "high";
  url?: string;
  statusCode?: number;
  /** When the event occurred (epoch ms) */
  at?: number;
};

/** Ticket-like bug record for UI and integrations (Jira, Linear, GitHub) */
export type Bug = {
  id?: string; // Set when loaded from bugs table
  name: string;
  description: string;
  category: "visual" | "functional" | "ux" | "other";
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  /** Filename under SCREENSHOTS_DIR/<runId>/ (e.g. bug-0.jpg); bytes on disk only. */
  screenshotPath?: string | null;
  stepsToReproduce: string[];
  url?: string | null;
  runId: string;
  runLabel?: string | null;
  reportedAt: string; // ISO
  environment?: string | null;
  /** Step index in the run (for reference) */
  index?: number;
  /** Which agent found this bug (multi-agent runs) */
  source?: BugSource;
  /** Bounding box when the model provided one (same semantics as ReviewBug.region). */
  region?: { x: number; y: number; w: number; h: number };
};
