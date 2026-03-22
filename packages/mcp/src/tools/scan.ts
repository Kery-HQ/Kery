import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerScanTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_scan",
    `Scan a web application to discover all pages and routes. This performs a BFS crawl of the app, extracting forms, buttons, and navigation links. Takes 1-3 minutes depending on app size. Returns the list of discovered pages.`,
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

      try {
        const scanResult = await client.waitForScan(projectId);
        const { pages } = await client.getPages(projectId);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: scanResult.status,
              pagesFound: pages.length,
              pages: pages.map((p) => ({
                route: p.normalized_route,
                title: p.title,
                health: p.health_status,
              })),
              webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scan failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
