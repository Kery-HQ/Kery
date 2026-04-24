import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

const AuthSchema = z
  .object({
    mode: z
      .enum(["none", "form", "clerk", "supabase"])
      .describe(
        "Authentication mode. 'none' for public apps. 'form' for standard username/password login pages (auto-detects form fields by default). 'clerk' for Clerk-protected apps. 'supabase' for Supabase Auth.",
      ),

    form: z
      .object({
        loginUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "URL of the login page (e.g. 'http://localhost:3000/login'). Omit to let Kery auto-detect the login page.",
          ),
        username: z.string().optional().describe("Login username or email address."),
        password: z.string().optional().describe("Login password."),
        totpSecret: z
          .string()
          .optional()
          .describe(
            "Base32-encoded TOTP secret for apps protected by 2FA/MFA (e.g. from an authenticator app setup QR code). Kery will auto-generate and enter the 6-digit code.",
          ),
      })
      .optional()
      .describe("Form login config — provide when mode is 'form'."),

    clerk: z
      .object({
        frontendApiUrl: z
          .string()
          .describe(
            "Your Clerk Frontend API URL. Found in the Clerk dashboard under 'API Keys' (e.g. 'https://your-app.clerk.accounts.dev'). Do NOT use the Backend API URL.",
          ),
        secretKey: z
          .string()
          .describe("Clerk secret key (starts with 'sk_test_' or 'sk_live_')."),
        email: z
          .string()
          .email()
          .describe("Email address of the test user Kery will sign in as."),
      })
      .optional()
      .describe("Clerk auth config — provide when mode is 'clerk'."),

    supabase: z
      .object({
        projectUrl: z
          .string()
          .url()
          .describe(
            "Supabase project URL (e.g. 'https://abcdefgh.supabase.co'). Found in the Supabase dashboard under Project Settings → API.",
          ),
        anonKey: z
          .string()
          .describe(
            "Supabase anon (public) key. Found in Project Settings → API. Use the service_role key only if your test user needs elevated access.",
          ),
        email: z.string().email().describe("Test user email address."),
        password: z.string().describe("Test user password."),
      })
      .optional()
      .describe("Supabase auth config — provide when mode is 'supabase'."),
  })
  .optional()
  .describe(
    "Authentication configuration. Omit entirely for public (no-login) apps.",
  );

export function registerSetupTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_setup_project",
    `Create a Kery testing project for a web application. Idempotent — if a project with the same name exists it is reused. Sets up the project, a default environment pointing to the app URL, and optionally configures authentication (none, form login, Clerk, or Supabase).`,
    {
      name: z.string().describe("Project name (e.g. 'my-saas-app')."),
      baseUrl: z
        .string()
        .url()
        .describe("The base URL of the app to test (e.g. 'http://localhost:3000')."),
      domain: z.string().optional().describe("Domain hint for the crawler (optional)."),
      auth: AuthSchema,
    },
    async ({ name, baseUrl, domain, auth }) => {
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

      // Map simplified auth to underlying API format
      if (auth && auth.mode !== "none") {
        let apiMode: string;
        let apiConfig: Record<string, unknown>;

        if (auth.mode === "form") {
          apiMode = "ui";
          apiConfig = {
            loginUrl: auth.form?.loginUrl,
            autoDetectSelectors: true,
            credentials: {
              username: auth.form?.username,
              password: auth.form?.password,
            },
            ...(auth.form?.totpSecret ? { totp_secret: auth.form.totpSecret } : {}),
          };
        } else if (auth.mode === "clerk") {
          apiMode = "tokenProvider";
          apiConfig = {
            tokenProvider: {
              type: "clerk",
              apiUrl: auth.clerk!.frontendApiUrl,
              apiKey: auth.clerk!.secretKey,
              credentials: { email: auth.clerk!.email, password: "" },
            },
          };
        } else {
          // supabase
          apiMode = "tokenProvider";
          apiConfig = {
            tokenProvider: {
              type: "supabase",
              apiUrl: auth.supabase!.projectUrl,
              apiKey: auth.supabase!.anonKey,
              credentials: {
                email: auth.supabase!.email,
                password: auth.supabase!.password,
              },
            },
          };
        }

        await client.setAuth(project.id, env.id, apiMode, apiConfig);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            projectId: project.id,
            environmentId: env.id,
            projectName: project.name,
            baseUrl: env.base_url,
            authMode: auth?.mode ?? "none",
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
