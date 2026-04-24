import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRouteTools(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_list_routes",
    `List all discovered routes/pages for a project. Returns current routes from the last scan without triggering a new one. Use kery_scan to refresh the route list. Each route includes health status, issue count, form/interaction counts, and whether it is enabled for testing.`,
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

      const { pages, coverage } = await client.getPages(projectId);

      if (pages.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "No routes discovered yet. Run kery_scan first to crawl the application.",
              routes: [],
              coverage,
              webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: pages.length,
            coverage,
            routes: pages.map((p: any) => ({
              id: p.id,
              route: p.route ?? p.normalized_route,
              title: p.title,
              health: p.health ?? p.health_status,
              issues: p.issues ?? p.issues_count ?? 0,
              enabled: p.enabled ?? true,
              formCount: p.formCount ?? 0,
              interactionCount: p.interactionCount ?? 0,
            })),
            webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
          }),
        }],
      };
    },
  );
}
