import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRunTestTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_run_test",
    `Run a test against a web application. Provide an intent (what to test) OR a testId (saved test) OR a pageRoute (specific page to inspect). The test runs in a real browser with an AI agent navigating and detecting bugs. Returns pass/fail status and any bugs found. Typically takes 1-5 minutes.`,
    {
      projectId: z.string().uuid().describe("The Kery project ID"),
      intent: z.string().optional().describe("What to test, e.g. 'verify the signup flow works' or 'check that the settings page loads correctly'"),
      testId: z.string().uuid().optional().describe("Run a saved test by its ID"),
      pageRoute: z.string().optional().describe("Test a specific page by route, e.g. '/settings' or '/dashboard'. Resolved to a destination internally."),
      environmentId: z.string().uuid().optional().describe("Environment to test against. Defaults to the project's default environment."),
    },
    async ({ projectId, intent, testId, pageRoute, environmentId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
          isError: true,
        };
      }

      // Resolve environment
      if (!environmentId) {
        try {
          const env = await client.getDefaultEnvironment(projectId);
          environmentId = env.id;
        } catch {
          return {
            content: [{ type: "text", text: "No environment configured. Use kery_setup_project first." }],
            isError: true,
          };
        }
      }

      // Resolve pageRoute to destinationId
      let destinationId: string | undefined;
      if (pageRoute) {
        const { pages } = await client.getPages(projectId);
        const match = pages.find((p) => p.normalized_route === pageRoute);
        if (!match) {
          const available = pages.map((p) => p.normalized_route).slice(0, 20);
          return {
            content: [{
              type: "text",
              text: `Page route "${pageRoute}" not found. Run kery_scan first. Available routes: ${JSON.stringify(available)}`,
            }],
            isError: true,
          };
        }
        destinationId = match.id;
      }

      if (!intent && !testId && !destinationId) {
        return {
          content: [{ type: "text", text: "Provide at least one of: intent, testId, or pageRoute." }],
          isError: true,
        };
      }

      try {
        const { runId } = await client.startRun(projectId, {
          environmentId,
          intent,
          testId,
          destinationId,
        });

        const run = await client.waitForRun(runId);

        // Strip screenshots from bugs (too large for LLM context)
        const bugs = (run.bugs_json ?? []).map(({ screenshotBase64, screenshotPath, ...rest }) => rest);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId: run.id,
              status: run.status,
              stepsCount: run.steps_json?.length ?? 0,
              bugsFound: bugs.map((b) => ({
                name: b.name,
                description: b.description,
                severity: b.severity,
                category: b.category,
                url: b.url,
              })),
              webUrl: client.buildWebUrl(`/runs/${run.id}`),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Test run failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
