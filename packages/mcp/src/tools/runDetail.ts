import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRunDetailTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_run",
    `Get detailed results of a specific test run. Includes status, steps taken, and bugs found.`,
    {
      runId: z.string().uuid().describe("The run ID to look up"),
    },
    async ({ runId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
          isError: true,
        };
      }

      try {
        const run = await client.getRun(runId);
        const bugs = (run.bugs_json ?? []).map(({ screenshotBase64, screenshotPath, ...rest }) => rest);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId: run.id,
              status: run.status,
              startedAt: run.started_at,
              completedAt: run.completed_at,
              steps: (run.steps_json ?? []).map((s) => ({
                action: s.action,
                target: s.target,
                value: s.value,
                status: s.status,
                reasoning: s.reasoning,
              })),
              bugs: bugs.map((b) => ({
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
      } catch {
        return {
          content: [{ type: "text", text: `Run "${runId}" not found.` }],
          isError: true,
        };
      }
    },
  );
}
