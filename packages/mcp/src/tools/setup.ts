import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";
import { AuthInput, authInputToApiPayload, ProjectNameField } from "../validation.js";

export function registerSetupTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_setup_project",
    `Create or reconfigure a Kery testing project for a web application. This is the FIRST tool to call when setting up Kery for any app.

WHEN TO USE:
  • User says "set up kery for my app", "add my project to kery", "configure kery for [app name]"
  • Starting fresh with a new web app
  • Reconfiguring an existing project (reuses it by name)

WHAT THIS DOES:
  1. Verifies Kery is running (helpful error if not)
  2. Finds or creates a project with the given name
  3. Finds or creates a default environment pointing to your app URL
  4. Configures authentication (if provided)
  5. Returns projectId + environmentId needed for all other tools
  6. Returns a step-by-step next-actions checklist

AUTH MODES — set auth.mode to:
  'none'     — public app, no login (default if auth is omitted)
  'form'     — standard HTML login form. Auto-detection always on: loginUrl is optional
               (Kery falls back to base-URL discovery if omitted or login fails). Provide username, password.
  'clerk'    — Clerk-protected app (provide frontendApiUrl, secretKey, email)
  'supabase' — Supabase Auth (provide projectUrl, anonKey, email, password)

VALIDATION enforced before the API call:
  • Project name: min 2 characters
  • baseUrl: must be a valid URL including scheme (http:// or https://)
  • auth.mode='clerk': secretKey must start with sk_test_ or sk_live_
  • auth.mode='supabase': projectUrl must be a URL, anonKey and password non-empty
  • Each auth mode only accepts its own fields

After setup → call kery_scan → call kery_run_test`,
    {
      name: ProjectNameField.describe("Project name (min 2 chars), e.g. 'my-saas-app', 'acme-dashboard'"),
      baseUrl: z
        .string()
        .url("Must be a valid URL with scheme, e.g. 'http://localhost:3000' or 'https://staging.myapp.com'")
        .describe("Base URL of the app to test"),
      domain: z
        .string()
        .optional()
        .describe(
          "Domain hint for the crawler — keeps crawl within this domain (e.g. 'localhost:3000'). Optional.",
        ),
      auth: AuthInput.optional().describe(
        "Authentication config. Omit entirely for public apps. " +
        "Each mode requires its own fields — see the auth.mode description.",
      ),
    },
    async ({ name, baseUrl, domain, auth }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Kery is not running.",
              fix: "Call kery_start to launch Kery via Docker, then retry kery_setup_project.",
              alternative: "Run 'docker compose up -d' in the Kery repo directory.",
            }),
          }],
          isError: true,
        };
      }

      // Find or create project
      const existing = await client.listProjects();
      let project = existing.find((p) => p.name === name);
      let created = false;

      if (!project) {
        project = await client.createProject(name, domain);
        created = true;
      }

      // Find or create default environment
      const envs = await client.listEnvironments(project.id);
      let env = envs.find((e) => e.base_url === baseUrl) ?? envs.find((e) => e.is_default);

      if (!env) {
        env = await client.createEnvironment(project.id, "Local Dev", baseUrl, true);
      }

      // Configure auth
      if (auth && auth.mode !== "none") {
        const { apiMode, apiConfig } = authInputToApiPayload(auth);
        await client.setAuth(project.id, env.id, apiMode, apiConfig);
      }

      const authLabel = auth?.mode ?? "none";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: created ? "created" : "existing_reused",
            projectId: project.id,
            environmentId: env.id,
            projectName: project.name,
            baseUrl: env.base_url,
            authMode: authLabel,
            webUrl: client.buildWebUrl(`/projects/${project.id}`),
            message: created
              ? `Project "${name}" created successfully.`
              : `Project "${name}" already exists — reusing it.`,
            nextSteps: [
              `Step 1 ✓ — Project set up. projectId="${project.id}", environmentId="${env.id}"`,
              `Step 2 — Call kery_scan with projectId="${project.id}" to crawl ${baseUrl} and discover all pages (1-3 min).`,
              `Step 3 — Call kery_run_test with projectId="${project.id}" and an intent like "verify the main user flow works".`,
              `Step 4 — Call kery_get_bugs with projectId="${project.id}" to review any bugs found.`,
              authLabel === "none"
                ? "Note: No auth configured. If your app requires login, call kery_update_auth to add credentials."
                : `Auth configured (${authLabel}). Kery will automatically sign in before each test run.`,
            ],
          }),
        }],
      };
    },
  );
}
