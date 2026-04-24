import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRunDetailTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_run",
    `Get detailed results of a specific test run, including every step the AI agent took and all bugs found.

WHEN TO USE:
  • After kery_run_test returns a runId, call this to get the full trace
  • User asks "what happened in that test run", "show me the steps"
  • Debugging why a test failed — the steps show exactly what the agent clicked/typed and where it got stuck
  • Getting screenshot URLs for bugs found in a run

STEP STRUCTURE: Each step shows the agent's action (click, type, navigate, observe), the target element, reasoning, and status (ok/failed/skipped).

Get runIds from kery_run_test results or kery_list_runs.`,
    {
      runId: z.string().uuid().describe("Run ID to look up (get from kery_run_test or kery_list_runs)"),
      includeScreenshots: z
        .boolean()
        .default(false)
        .describe(
          "When true, each bug includes a screenshotUrl (direct URL to a JPEG). Open in a browser to view. Defaults to false to keep response size small.",
        ),
    },
    async ({ runId, includeScreenshots }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start to launch Docker, or check your connection." }],
          isError: true,
        };
      }

      try {
        const run = await client.getRun(runId);
        const rawBugs = run.bugs_json ?? [];

        const bugs = rawBugs.map(({ screenshotBase64, screenshotPath, ...rest }) => {
          const bug: Record<string, unknown> = {
            id: rest.id,
            name: rest.name,
            description: rest.description,
            severity: rest.severity,
            category: rest.category,
            status: rest.status,
            url: rest.url,
            source: rest.source,
            reportedAt: rest.reportedAt,
          };
          if (includeScreenshots && screenshotPath) {
            bug.screenshotUrl = `${client.apiUrl}/api/bugs/${run.id}/${screenshotPath}`;
          }
          return bug;
        });

        const failedSteps = (run.steps_json ?? []).filter((s) => s.status === "failed");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId: run.id,
              status: run.status,
              displayName: (run as any).display_name ?? null,
              summary: run.summary ?? null,
              startedAt: run.started_at,
              completedAt: run.completed_at,
              stepsCount: (run.steps_json ?? []).length,
              failedStepsCount: failedSteps.length,
              steps: (run.steps_json ?? []).map((s) => ({
                index: s.index,
                action: s.action,
                target: s.target,
                value: s.value,
                status: s.status,
                reasoning: s.reasoning,
                url: s.url,
              })),
              bugs,
              ...(includeScreenshots && {
                screenshotNote:
                  "screenshotUrl fields are direct JPEG URLs served by the Kery API, accessible while Kery is running.",
              }),
              nextSteps: [
                bugs.length > 0
                  ? `${bugs.length} bug(s) found. Call kery_update_bug to mark them as resolved or wont_fix after reviewing.`
                  : "No bugs found in this run.",
                failedSteps.length > 0
                  ? `${failedSteps.length} steps failed. Check the steps array above for details on what the agent couldn't do.`
                  : null,
              ].filter(Boolean),
              webUrl: client.buildWebUrl(`/runs/${run.id}`),
            }),
          }],
        };
      } catch {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Run "${runId}" not found.`,
              fix: "Call kery_list_runs to see available run IDs for your project.",
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
