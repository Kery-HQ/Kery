import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerSetupTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_setup_project",
    `Create a Kery testing project for a web application. Idempotent — if a project with the same name exists, it is reused. Sets up the project, a default environment pointing to the app's URL, and optionally configures authentication.`,
    {
      name: z.string().describe("Project name (e.g. 'my-saas-app')"),
      baseUrl: z.string().url().describe("The app's URL to test (e.g. 'http://localhost:3000')"),
      domain: z.string().optional().describe("Domain hint (optional)"),
      authMode: z.enum(["ui", "apiToken", "oauthToken", "tokenProvider", "none"]).optional()
        .describe("Authentication mode. 'ui' for form-based login, 'tokenProvider' for Clerk/Supabase token injection, 'apiToken' for custom API token, 'none' for no auth."),
      authConfig: z.record(z.unknown()).optional()
        .describe("Auth configuration object (varies by mode). For 'ui': { loginUrl, credentials: { username, password }, selectors: { usernameField, passwordField, submitButton } }. For 'tokenProvider': { tokenProvider: { type: 'clerk' | 'supabase', apiUrl, apiKey, credentials: { email, password } } }. Clerk apiUrl is the Backend API URL (https://api.clerk.com), apiKey is your secret key (sk_test_...). Supabase apiUrl is your project URL (https://ref.supabase.co), apiKey is the anon key."),
    },
    async ({ name, baseUrl, domain, authMode, authConfig }) => {
      // Check health first
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start, or run: docker compose up -d" }],
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

      // Set auth if provided
      if (authMode && authMode !== "none") {
        await client.setAuth(project.id, env.id, authMode, authConfig);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            projectId: project.id,
            environmentId: env.id,
            projectName: project.name,
            baseUrl: env.base_url,
            created,
            webUrl: client.buildWebUrl(`/projects/${project.id}`),
            message: created
              ? `Project "${name}" created. Next: run kery_scan to discover pages, or kery_run_test to test immediately.`
              : `Project "${name}" already exists. Reusing it.`,
          }),
        }],
      };
    },
  );
}
