import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";
import { AuthInput, authInputToApiPayload } from "../validation.js";

export function registerAuthTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_update_auth",
    `Update the authentication configuration for a project environment.

WHEN TO USE:
  • User says "add login credentials", "configure auth", "my app requires login", "update the password"
  • Setting up auth for a newly added environment (after kery_add_environment)
  • Rotating credentials (password changed, new secret key issued)
  • Switching auth provider (e.g. from form to clerk)
  • Disabling auth — set mode to 'none' for public environments

IMPORTANT — get IDs first:
  Call kery_list_projects to see projectId and environmentId before calling this tool.

AUTH MODE GUIDE:
  'none'     — public app, no login. Clears any existing auth config.
  'form'     — standard HTML login form. Auto-detection is always on: Kery finds the login
               page and form selectors automatically. loginUrl is an optional hint — if omitted
               or if the login attempt fails, Kery falls back to base-URL route discovery.
               Provide username and password. Add totpSecret for 2FA/TOTP apps.
  'clerk'    — app uses Clerk. Provide frontendApiUrl, secretKey (sk_test_/sk_live_), email.
               Your app must be configured correctly or sign-in will silently redirect to accounts.dev:
                 1. clerkMiddleware() must be present in middleware.ts (or proxy.ts for Next.js 16+).
                    Without it, auth() always returns null server-side even with a valid client session.
                 2. /sign-in route must render Clerk's <SignIn /> component. Kery lands here, loads
                    Clerk JS, signs in via @clerk/testing, then redirects back to the app.
                    Do NOT make / a public route — unauthenticated users must hit /sign-in first.
                 3. Set NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in in .env.local so auth.protect()
                    redirects to your app's own sign-in page, not the hosted accounts.dev/sign-in.
                 4. Add host.docker.internal (and any other origins Kery uses) to:
                    - Clerk dashboard → allowed_origins (via PATCH /v1/instance or the dashboard UI)
                    - ClerkProvider allowedRedirectOrigins prop in your app layout
                    Without these, the redirect after sign-in goes to accounts.dev/default-redirect.
               If running against a local dev server:
                 - Start Next.js with: npm run dev -- -H 0.0.0.0 (binds to all interfaces, not just 127.0.0.1)
                 - Set the environment baseUrl to http://host.docker.internal:<port>, not localhost
                 - Create the test user in the Clerk dashboard for your app (not your personal Clerk account)
  'supabase' — app uses Supabase Auth. Provide projectUrl, anonKey, email, password.

VALIDATION enforced before the API call:
  • 'clerk' mode requires frontendApiUrl (URL), secretKey (must start sk_test_ or sk_live_), email
  • 'supabase' mode requires projectUrl (URL), anonKey (non-empty), email, password (non-empty)
  • Each mode only accepts its own fields — mismatches are caught immediately`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      environmentId: z
        .string()
        .uuid()
        .describe("Environment ID to configure auth for (get from kery_list_projects)"),
      auth: AuthInput,
    },
    async ({ projectId, environmentId, auth }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      const { apiMode, apiConfig } = authInputToApiPayload(auth);
      await client.setAuth(projectId, environmentId, apiMode, apiConfig);

      const statusMessages: Record<string, string> = {
        none: "Auth cleared — this environment will test without logging in.",
        form: "Form login configured. Kery will navigate to the login page and sign in before each test.",
        clerk: "Clerk auth configured. Kery will obtain a session token via the Clerk API before each test.",
        supabase: "Supabase auth configured. Kery will sign in via the Supabase API before each test.",
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            projectId,
            environmentId,
            authMode: auth.mode,
            message: statusMessages[auth.mode],
            nextSteps: [
              auth.mode !== "none"
                ? `Auth set (${auth.mode}). Call kery_run_test to verify sign-in works — if the test reaches authenticated pages, auth is working.`
                : "Auth cleared. Call kery_run_test to test public pages.",
            ],
          }),
        }],
      };
    },
  );
}
