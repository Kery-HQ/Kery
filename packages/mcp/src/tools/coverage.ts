import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

export function registerCoverageTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_coverage",
    `Get test coverage overview for a project — which pages have been tested, which have issues, and which are untested.

WHEN TO USE:
  • User asks "what's the test coverage", "which pages haven't been tested", "show me the testing status"
  • After a batch of tests to see overall progress
  • Planning what to test next

Returns page-level coverage stats and a breakdown of untested, clean, and issue pages.
Call kery_run_test with a specific pageRoute for untested pages, or kery_get_bugs to review known issues.`,
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

      const [coverage, { pages }] = await Promise.all([
        client.getCoverage(projectId),
        client.getPages(projectId),
      ]);

      const coveragePct = coverage.total > 0
        ? Math.round((coverage.tested / coverage.total) * 100)
        : 0;

      const untestedPages = pages
        .filter((p) => p.health_status === "untested")
        .map((p) => p.normalized_route);

      const issuePages = pages
        .filter((p) => p.health_status === "issues")
        .map((p) => ({ route: p.normalized_route, issues: p.issues_count }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            coveragePct,
            ...coverage,
            pages: pages.map((p) => ({
              route: p.normalized_route,
              title: p.title,
              health: p.health_status,
              issueCount: p.issues_count,
            })),
            nextSteps: [
              coverage.untested > 0
                ? `${coverage.untested} pages untested. Test them by calling kery_run_test with pageRoute for: ${untestedPages.slice(0, 3).join(", ")}${untestedPages.length > 3 ? " and more..." : ""}`
                : null,
              issuePages.length > 0
                ? `${issuePages.length} pages have issues. Call kery_get_bugs with projectId="${projectId}" to review them.`
                : null,
              coverage.untested === 0 && issuePages.length === 0
                ? "All pages tested and clean. Run kery_scan to check for new pages."
                : null,
            ].filter(Boolean),
            webUrl: client.buildWebUrl(`/projects/${projectId}/pages`),
          }),
        }],
      };
    },
  );
}
