import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

export function registerScanTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_scan",
    `Crawl a web application to discover all pages, routes, forms, and interactive elements. This is step 2 in the Kery workflow after kery_setup_project.

WHEN TO USE:
  • After creating a project with kery_setup_project (always scan before first test)
  • When the app has changed significantly (new pages added, routes changed)
  • User says "scan my app", "discover pages", "crawl the site"
  • kery_run_test returns "no pages found" — run this first

WHAT THIS DOES:
  • Uses a BFS crawler to visit every page in the app
  • Discovers routes, forms, buttons, modals, and navigation links
  • Builds a page tree used by the AI test agent
  • Takes 1-3 minutes depending on app size

After scanning, call kery_list_routes to see what was found, or kery_run_test to start testing immediately.`,
    {
      projectId: z
        .string()
        .uuid()
        .describe("Project ID to scan (get from kery_setup_project or kery_list_projects)"),
    },
    async ({ projectId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start to launch Docker, or check your connection." }],
          isError: true,
        };
      }

      try {
        const scanResult = await client.waitForScan(projectId);
        const { pages } = await client.getPages(projectId);

        const byHealth = {
          clean: pages.filter((p: any) => p.health === "clean" || p.health_status === "clean").length,
          issues: pages.filter((p: any) => p.health === "issues" || p.health_status === "issues").length,
          untested: pages.filter((p: any) => p.health === "untested" || p.health_status === "untested").length,
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: scanResult.status,
              pagesFound: pages.length,
              pagesVisited: scanResult.pages_visited ?? pages.length,
              costUsd: scanResult.cost_usd ?? null,
              byHealth,
              pages: pages.map((p: any) => ({
                id: p.id,
                route: p.normalized_route ?? p.route,
                title: p.title,
                health: p.health_status ?? p.health,
                formCount: p.formCount ?? 0,
                interactionCount: p.interactionCount ?? 0,
              })),
              webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
              nextSteps: [
                `Scan complete — found ${pages.length} pages.`,
                `Call kery_run_test with projectId="${projectId}" and an intent like "verify the main user flow works" to run your first AI test.`,
                pages.length > 5
                  ? `Or call kery_run_test with a specific pageRoute (e.g. '/dashboard') to test a single page.`
                  : null,
              ].filter(Boolean),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
              nextSteps: [
                "Make sure the app is running and accessible at the configured baseUrl.",
                "Check kery_list_projects to verify the baseUrl is correct.",
                "If the URL is wrong, call kery_update_environment to fix it.",
              ],
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
