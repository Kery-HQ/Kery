import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

export function registerRunsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_stop_run",
    `Stop a test run that is currently queued or running.

WHEN TO USE:
  • User says "cancel that test", "stop the running test"
  • A test is taking too long and you want to abort it
  • You triggered a test by mistake

The run is gracefully stopped and its status is set to 'failed'. Already-completed runs are unaffected.

Get runId from kery_list_runs or kery_run_test output.`,
    {
      runId: z.string().uuid().describe("Run ID to stop (get from kery_list_runs or kery_run_test output)"),
    },
    async ({ runId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      try {
        await client.stopRun(runId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              stopped: true,
              runId,
              message: "Stop signal sent. The run will terminate shortly.",
              nextSteps: [`Call kery_get_run with runId="${runId}" to confirm the run has stopped.`],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to stop run: ${err instanceof Error ? err.message : String(err)}`,
              fix: "The run may have already completed. Call kery_get_run to check its current status.",
            }),
          }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "kery_list_runs",
    `List recent test runs for a project. Each run shows status (passed/failed/running/queued), the test name or intent, start/end times, and a link to the full run detail.

WHEN TO USE:
  • User asks "what tests ran recently" or "show me the last test results"
  • You want to find a runId to pass to kery_get_run for detailed steps and bugs
  • Checking whether a queued/running test has completed
  • Getting the pass rate or recent failure history

After finding a run of interest, call kery_get_run with its runId for detailed step-by-step results and bugs.`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of recent runs to return (default 10, max 50)"),
      status: z
        .enum(["all", "passed", "failed", "running", "queued"])
        .default("all")
        .describe("Filter by run status. Default: 'all'."),
    },
    async ({ projectId, limit, status }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      const runs = await client.listRuns(projectId);

      const filtered = status === "all"
        ? runs
        : runs.filter((r) => r.status === status);

      const sliced = filtered.slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: filtered.length,
            showing: sliced.length,
            runs: sliced.map((r) => ({
              id: r.id,
              displayName: (r as any).display_name ?? null,
              status: r.status,
              startedAt: r.started_at,
              completedAt: r.completed_at,
              bugCount: (r.bugs_json ?? []).length,
              webUrl: client.buildWebUrl(`/runs/${r.id}`),
            })),
            nextSteps:
              sliced.length > 0
                ? [`Call kery_get_run with runId="${sliced[0].id}" to see detailed steps and bugs for the most recent run.`]
                : ["No runs found. Call kery_run_test to start a new test."],
          }),
        }],
      };
    },
  );
}
