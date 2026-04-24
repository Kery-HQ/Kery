import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRunDetailTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_run",
    `Get detailed results of a specific test run. Includes status, steps taken, and bugs found. Use includeScreenshots to get URLs pointing to bug screenshots — URLs are returned instead of raw image data to keep the response size manageable. Open the URLs in a browser or pass them to an image viewer.`,
    {
      runId: z.string().uuid().describe("The run ID to look up"),
      includeScreenshots: z
        .boolean()
        .default(false)
        .describe(
          "When true, each bug in the response will include a screenshotUrl (a direct URL to the JPEG screenshot). Screenshots are NOT embedded — the URL must be opened separately. Defaults to false.",
        ),
    },
    async ({ runId, includeScreenshots }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
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

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId: run.id,
              status: run.status,
              displayName: (run as any).display_name ?? null,
              startedAt: run.started_at,
              completedAt: run.completed_at,
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
                  "screenshotUrl fields point to JPEG images served by the Kery API. They are accessible as long as Kery is running.",
              }),
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
