import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerCoverageTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_coverage",
    `Get test coverage overview for a project. Shows which pages have been tested, which have issues, and which are untested.`,
    {
      projectId: z.string().uuid().describe("The Kery project ID"),
    },
    async ({ projectId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
          isError: true,
        };
      }

      const [coverage, { pages }] = await Promise.all([
        client.getCoverage(projectId),
        client.getPages(projectId),
      ]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...coverage,
            pages: pages.map((p) => ({
              route: p.normalized_route,
              title: p.title,
              health: p.health_status,
              issueCount: p.issues_count,
            })),
            webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
          }),
        }],
      };
    },
  );
}
