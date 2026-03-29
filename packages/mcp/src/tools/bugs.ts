import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerBugsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_bugs",
    `List bugs found by Kery testing for a project. Returns bug details including name, description, severity, and steps to reproduce. Screenshots are available in the web UI.`,
    {
      projectId: z.string().uuid().describe("The Kery project ID"),
      status: z.enum(["open", "resolved", "all"]).default("open")
        .describe("Filter by bug status. Default: 'open'."),
    },
    async ({ projectId, status }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
          isError: true,
        };
      }

      const allBugs = await client.getBugs(projectId);
      const filtered = status === "all"
        ? allBugs
        : allBugs.filter((b) =>
            status === "open"
              ? b.status === "open" || b.status === "in_progress"
              : b.status === "resolved",
          );

      // Strip screenshots
      const bugs = filtered.map(({ screenshotBase64, screenshotPath, ...rest }) => rest);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: bugs.length,
            bugs: bugs.map((b) => ({
              id: b.id,
              name: b.name,
              description: b.description,
              category: b.category,
              severity: b.severity,
              status: b.status,
              stepsToReproduce: b.stepsToReproduce,
              url: b.url,
              reportedAt: b.reportedAt,
            })),
            webUrl: client.buildWebUrl(`/projects/${projectId}/bugs`),
          }),
        }],
      };
    },
  );
}
