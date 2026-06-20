/**
 * Shared Zod schemas that mirror the Kery API validation exactly.
 * Single source of truth — update here when the API constraints change.
 *
 * API source files:
 *   apps/api/src/routes/params.ts
 *   apps/api/src/routes/projects.ts
 *   apps/api/src/routes/tests.ts
 *   apps/api/src/routes/bugs.ts
 *   apps/api/src/routes/runs.ts
 *   apps/api/src/routes/settings.ts
 */

import { z } from "zod";

// ── Projects ──────────────────────────────────────────────────────────────────

/** API: projects.ts — z.object({ name: z.string().min(2), domain: z.string().optional().nullable() }) */
export const ProjectNameField = z
  .string()
  .min(2, "Project name must be at least 2 characters");

export const ProjectUpdateFields = z
  .object({
    name: ProjectNameField.optional(),
    domain: z.string().nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.domain !== undefined, {
    message: "At least one of name or domain is required",
  });

// ── Environments ──────────────────────────────────────────────────────────────

/** API: projects.ts — EnvironmentSchema / EnvironmentUpdateSchema */
export const EnvNameField = z
  .string()
  .min(2, "Environment name must be at least 2 characters");

export const EnvUpdateFields = z
  .object({
    name: EnvNameField.optional(),
    baseUrl: z.string().url("Must be a valid URL (include http:// or https://)").optional(),
  })
  .refine((b) => b.name !== undefined || b.baseUrl !== undefined, {
    message: "At least one of name or baseUrl is required",
  });

// ── Authentication ────────────────────────────────────────────────────────────

/**
 * Discriminated union mirroring the API auth modes.
 *
 * API internal modes:
 *   "none"          → delete auth_config row
 *   "ui"            → form login (MCP alias: "form")
 *   "tokenProvider" → Clerk or Supabase (MCP aliases: "clerk" | "supabase")
 *
 * The discriminated union ensures the agent always provides the required
 * sub-fields for each mode rather than discovering the requirement at API call time.
 */
export const AuthInput = z.discriminatedUnion("mode", [
  // No auth — public app
  z.object({
    mode: z.literal("none").describe("Public app — no login required"),
  }),

  // Form login
  z.object({
    mode: z.literal("form").describe(
      "Standard HTML login form. Kery always auto-detects login page and form selectors — " +
      "loginUrl and selector hints are optional overrides. If omitted or if a login attempt fails, " +
      "Kery falls back to base-URL route discovery automatically.",
    ),
    loginUrl: z
      .string()
      .url("Must be a valid URL, e.g. 'http://localhost:3000/login'")
      .optional()
      .describe(
        "Login page URL — optional hint. Leave blank and Kery will discover the login route " +
        "from the environment base URL. Also used as a fallback starting point if a provided URL fails.",
      ),
    username: z
      .string()
      .optional()
      .describe("Login username or email address"),
    password: z
      .string()
      .optional()
      .describe("Login password"),
    totpSecret: z
      .string()
      .optional()
      .describe(
        "Base32-encoded TOTP secret for 2FA-protected apps. " +
        "Kery will compute the 6-digit code automatically. " +
        "Found in your authenticator app's QR code setup screen.",
      ),
  }),

  // Clerk
  z.object({
    mode: z.literal("clerk").describe(
      "App uses Clerk for authentication. Kery obtains a session token via the Clerk API " +
      "(@clerk/testing) before each test run. " +
      "Requires: clerkMiddleware() in middleware, a /sign-in route with <SignIn />, " +
      "NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in in .env.local, and allowed origin/redirect settings " +
      "that include the configured environment URL. For local dev servers, use the same base URL " +
      "a user opens in a browser and verify reachability with kery_test_connection.",
    ),
    frontendApiUrl: z
      .string()
      .url("Must be a valid Clerk Frontend API URL, e.g. 'https://your-app.clerk.accounts.dev'")
      .describe(
        "Clerk Frontend API URL. Found in the Clerk dashboard → API Keys. " +
        "Looks like 'https://<your-slug>.clerk.accounts.dev'. " +
        "Do NOT use the Backend API URL (clerk.com/v1).",
      ),
    secretKey: z
      .string()
      .regex(
        /^sk_(test|live)_/,
        "Clerk secret key must start with 'sk_test_' (development) or 'sk_live_' (production)",
      )
      .describe(
        "Clerk secret key. Found in the Clerk dashboard → API Keys. " +
        "Starts with 'sk_test_' for development or 'sk_live_' for production.",
      ),
    email: z
      .string()
      .email("Must be a valid email address")
      .describe("Email of the test user Kery will authenticate as"),
  }),

  // Supabase
  z.object({
    mode: z.literal("supabase").describe(
      "App uses Supabase Auth. Kery signs in via the Supabase API and injects the session token.",
    ),
    projectUrl: z
      .string()
      .url("Must be a valid URL, e.g. 'https://abcdefgh.supabase.co'")
      .describe(
        "Supabase project URL. Found in the Supabase dashboard → Project Settings → API. " +
        "Format: 'https://<project-ref>.supabase.co'",
      ),
    anonKey: z
      .string()
      .min(1, "Supabase anon key is required")
      .describe(
        "Supabase anon (public) key. Found in Project Settings → API. " +
        "Use the service_role key only if your test user needs elevated permissions.",
      ),
    email: z
      .string()
      .email("Must be a valid email address")
      .describe("Test user email address"),
    password: z
      .string()
      .min(1, "Password is required")
      .describe("Test user password"),
  }),
]);

export type AuthInput = z.infer<typeof AuthInput>;

/** Map MCP auth input → API mode + config payload */
export function authInputToApiPayload(auth: AuthInput): { apiMode: string; apiConfig: Record<string, unknown> } {
  if (auth.mode === "none") {
    return { apiMode: "none", apiConfig: {} };
  }
  if (auth.mode === "form") {
    return {
      apiMode: "ui",
      apiConfig: {
        autoDetectLogin: true,
        autoDetectSelectors: true,
        loginUrl: auth.loginUrl,
        credentials: {
          username: auth.username,
          password: auth.password,
        },
        ...(auth.totpSecret ? { totp_secret: auth.totpSecret } : {}),
      },
    };
  }
  if (auth.mode === "clerk") {
    return {
      apiMode: "tokenProvider",
      apiConfig: {
        tokenProvider: {
          type: "clerk",
          apiUrl: auth.frontendApiUrl,
          apiKey: auth.secretKey,
          credentials: { email: auth.email, password: "" },
        },
      },
    };
  }
  // supabase
  return {
    apiMode: "tokenProvider",
    apiConfig: {
      tokenProvider: {
        type: "supabase",
        apiUrl: auth.projectUrl,
        apiKey: auth.anonKey,
        credentials: {
          email: auth.email,
          password: auth.password,
        },
      },
    },
  };
}

// ── Saved Tests ───────────────────────────────────────────────────────────────

/** API: tests.ts — TestSchema */
export const TestNameField = z
  .string()
  .min(2, "Test name must be at least 2 characters");

export const TestIntentField = z
  .string()
  .min(3, "Test intent must be at least 3 characters — describe what to verify");

// ── Runs ──────────────────────────────────────────────────────────────────────

/** API: runs.ts — RunSchema.intent: z.string().min(3).optional() */
export const RunIntentField = z
  .string()
  .min(3, "Intent must be at least 3 characters")
  .optional()
  .describe(
    "Natural language description of what to test (min 3 characters). Examples:\n" +
    "  'verify the signup flow works end to end'\n" +
    "  'check that users can log in and reach the dashboard'\n" +
    "  'test the settings page for visual and functional issues'",
  );

// ── Memory entries ────────────────────────────────────────────────────────────

/** API: projects.ts — MemoryEntryTypeEnum */
export const MemoryTypeField = z
  .enum(["learned_path", "ignore_region", "avoid_region", "bug_pattern", "tip"])
  .describe(
    "Memory entry type:\n" +
    "  'learned_path'   — a navigation sequence Kery learned (e.g. how to reach checkout)\n" +
    "  'ignore_region'  — a UI area to skip during inspection (e.g. a cookie banner)\n" +
    "  'avoid_region'   — a UI area to never interact with (e.g. a delete-all button)\n" +
    "  'bug_pattern'    — a known false-positive or expected quirk to ignore\n" +
    "  'tip'            — a general hint for the AI agent about this app",
  );

export const MemorySummaryField = z
  .string()
  .min(1, "Summary is required — provide a short one-line description")
  .describe("Short one-line description of the memory entry (shown in lists)");

export const MemoryContentField = z
  .string()
  .min(1, "Content is required — describe the memory in detail")
  .describe("Detailed content of the memory — the agent reads this during test runs");

export const MemoryConfidenceField = z
  .number()
  .int("Confidence must be an integer")
  .min(0, "Confidence must be between 0 and 100")
  .max(100, "Confidence must be between 0 and 100")
  .optional()
  .describe("Confidence score 0-100. Higher = more weight given to this memory. Default: 50.");

// ── Bug status ────────────────────────────────────────────────────────────────

/** API: params.ts — BugPatchBody */
export const BugStatusField = z
  .enum(["open", "in_progress", "resolved", "wont_fix"])
  .describe(
    "Bug status:\n" +
    "  'open'        — newly found, not yet triaged\n" +
    "  'in_progress' — being fixed\n" +
    "  'resolved'    — fix deployed (run a new test to verify)\n" +
    "  'wont_fix'    — false positive or known limitation, will not be fixed",
  );

// ── Settings ──────────────────────────────────────────────────────────────────

/** API: settings.ts — API_KEY_PROVIDERS */
export const ApiKeyProviderField = z
  .enum(["openai", "anthropic", "gemini", "openrouter"])
  .describe("LLM API key provider");

/** API: settings.ts — MODEL_KEYS */
export const ModelKeyField = z
  .enum(["agentModel", "auxiliaryModel", "reviewAgentModel", "stagehandModel"])
  .describe(
    "Model slot:\n" +
    "  'agentModel'       — browser automation decisions (default: gpt-4.1-mini)\n" +
    "  'auxiliaryModel'   — test plans, summaries, memory (default: gemini-2.5-flash)\n" +
    "  'reviewAgentModel' — post-run screenshot analysis (default: gemini-2.5-flash)\n" +
    "  'stagehandModel'   — Stagehand element finding (default: gpt-4o-mini)",
  );
