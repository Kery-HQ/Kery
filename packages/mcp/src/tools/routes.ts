import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerRouteTools(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_update_page",
    `Enable or disable a discovered page for testing.

WHEN TO USE:
  • User says "disable that page", "stop testing the admin page", "re-enable the settings page"
  • Excluding pages that are under construction or intentionally broken
  • Focusing Kery on the most important pages by disabling noise

Disabled pages are skipped during automated test coverage sweeps but can still be tested explicitly with kery_run_test by specifying pageRoute.

Get pageId from kery_list_routes (the 'id' field on each route).

VALIDATION:
  • pageId: must be a valid UUID
  • enabled: must be a boolean (true = active, false = disabled)`,
    {
      projectId: z.string().uuid().describe("Project ID"),
      pageId: z
        .string()
        .uuid()
        .describe("Page/destination ID to update (get from kery_list_routes — each route has an 'id' field)"),
      enabled: z
        .boolean()
        .describe("true to enable testing on this page, false to exclude it from automated sweeps"),
    },
    async ({ projectId, pageId, enabled }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      await client.updatePage(projectId, pageId, enabled);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            pageId,
            enabled,
            message: enabled
              ? "Page enabled — it will be included in automated test coverage sweeps."
              : "Page disabled — it will be skipped in automated sweeps. You can still test it explicitly with kery_run_test.",
            nextSteps: ["Call kery_list_routes to see the updated page status."],
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_list_routes",
    `List all discovered pages/routes for a project from the last scan, without triggering a new crawl.

WHEN TO USE:
  • You want to know what pages Kery has discovered without re-scanning
  • Picking a specific pageRoute to pass to kery_run_test
  • Checking health status of each page (clean, issues, untested, stale)
  • User asks "what pages have been discovered" or "show me the routes"

Each route includes: route path, page title, health status, issue count, and whether it is enabled for testing.

Health statuses:
  • 'untested'  — never been tested
  • 'clean'     — last test passed with no bugs
  • 'issues'    — bugs found on last test
  • 'stale'     — tested long ago, may be outdated

If no routes are shown, call kery_scan first to crawl the app.`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
    },
    async ({ projectId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start to launch Docker, or check your connection." }],
          isError: true,
        };
      }

      const { pages, coverage } = await client.getPages(projectId);

      if (pages.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "No routes discovered yet.",
              routes: [],
              coverage,
              nextSteps: [
                `Call kery_scan with projectId="${projectId}" to crawl the application and discover all pages.`,
                "Make sure the app is running at its configured URL before scanning.",
              ],
              webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
            }),
          }],
        };
      }

      const untestedRoutes = pages.filter((p: any) => (p.health ?? p.health_status) === "untested");
      const issueRoutes = pages.filter((p: any) => (p.health ?? p.health_status) === "issues");

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
            nextSteps: [
              untestedRoutes.length > 0
                ? `${untestedRoutes.length} pages are untested. Call kery_run_test with pageRoute to test a specific page, e.g. pageRoute="${(untestedRoutes[0] as any).route ?? untestedRoutes[0].normalized_route}".`
                : null,
              issueRoutes.length > 0
                ? `${issueRoutes.length} pages have issues. Call kery_get_bugs with projectId="${projectId}" to review them.`
                : null,
            ].filter(Boolean),
            webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
          }),
        }],
      };
    },
  );
}
