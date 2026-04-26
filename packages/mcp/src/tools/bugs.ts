import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

async function requireRunning(client: KeryClient) {
  const healthy = await client.checkHealth();
  if (!healthy) return "Kery is not running. Call kery_start to launch Docker, or check your connection.";
  return null;
}

export function registerBugsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_bugs",
    `List bugs found by Kery AI testing for a project.

WHEN TO USE:
  • User asks "what bugs did kery find", "show me the issues", "are there any open bugs"
  • After a test run completes to review what was discovered
  • To get bug IDs for kery_update_bug (marking as resolved, wont_fix, etc.)
  • Filtering bugs by route: use the returned destination_id to match against kery_list_routes IDs
  • Filtering bugs by flow: use the returned test_id to match against kery_list_tests IDs

Each bug includes name, description, severity (low/medium/high), category (visual/functional/ux/other),
the URL where it was found, a status, and source attribution:
  • destination_id — the route/page (from kery_list_routes) where the bug was found, or null
  • test_id        — the saved test flow (from kery_list_tests) that triggered it, or null
  Route-level bugs (no test_id) surface in the Route Detail Issues tab in the web UI.

Screenshots are viewable in the web UI via the webUrl.

After reviewing bugs, call kery_update_bug to mark them as resolved or wont_fix.`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      status: z
        .enum(["open", "resolved", "all"])
        .default("open")
        .describe("Filter by bug status. 'open' includes in_progress bugs. Default: 'open'."),
      severity: z
        .enum(["high", "medium", "low", "all"])
        .default("all")
        .describe("Filter by severity. Default: 'all'."),
    },
    async ({ projectId, status, severity }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      const allBugs = await client.getBugs(projectId);
      let filtered = status === "all"
        ? allBugs
        : allBugs.filter((b) =>
            status === "open"
              ? b.status === "open" || b.status === "in_progress"
              : b.status === "resolved",
          );

      if (severity !== "all") {
        filtered = filtered.filter((b) => b.severity === severity);
      }

      const bugs = filtered.map(({ screenshotBase64, screenshotPath, ...rest }) => rest);

      const nextSteps: string[] = [];
      if (bugs.length > 0) {
        nextSteps.push(
          `Found ${bugs.length} bugs. Use kery_update_bug with a bug's id to mark it as 'resolved' or 'wont_fix'.`,
        );
        if (bugs.some((b) => b.severity === "high")) {
          nextSteps.push("There are high-severity bugs — prioritize those first.");
        }
      } else {
        nextSteps.push("No bugs found matching these filters. Run kery_run_test to discover bugs.");
      }

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
              url: b.url,
              reportedAt: b.reportedAt,
              destination_id: (b as any).destination_id ?? null,
              test_id: (b as any).test_id ?? null,
            })),
            webUrl: client.buildWebUrl(`/projects/${projectId}/bugs`),
            nextSteps,
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_update_bug",
    `Update the status of a bug — mark it as resolved, wont_fix, in_progress, or reopen it.

WHEN TO USE:
  • User says "mark that bug as resolved", "that's a false positive", "we fixed the login bug"
  • Triaging bugs after a test run
  • Tracking which bugs have been actioned

Bug statuses:
  • 'open'        — newly found, not yet triaged
  • 'in_progress' — being worked on
  • 'resolved'    — fixed (run a new test to verify)
  • 'wont_fix'    — acknowledged but won't be fixed (false positive, known limitation, etc.)

Get bug IDs from kery_get_bugs.`,
    {
      projectId: z.string().uuid().describe("Project ID that owns the bug"),
      bugId: z.string().uuid().describe("Bug ID to update (get from kery_get_bugs)"),
      status: z
        .enum(["open", "in_progress", "resolved", "wont_fix"])
        .describe("New status for the bug"),
    },
    async ({ projectId, bugId, status }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      await client.updateBug(projectId, bugId, status);

      const statusMessages: Record<string, string> = {
        resolved: "Bug marked as resolved. Run kery_run_test again to verify the fix.",
        wont_fix: "Bug marked as wont_fix — it will be excluded from future open bug counts.",
        in_progress: "Bug marked as in_progress — your team is working on it.",
        open: "Bug reopened.",
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            bugId,
            newStatus: status,
            message: statusMessages[status],
            nextSteps: [statusMessages[status]],
          }),
        }],
      };
    },
  );
}
