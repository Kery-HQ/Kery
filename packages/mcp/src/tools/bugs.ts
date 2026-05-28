import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

async function requireRunning(client: KeryClient) {
  const healthy = await client.checkHealth();
  if (!healthy) return "Kery is not running. Call kery_start to launch Docker, or check your connection.";
  return null;
}

// User-friendly triage names mapped to DB statuses.
const STATUS_ALIASES: Record<string, "open" | "in_progress" | "resolved" | "wont_fix"> = {
  needs_review: "open",
  open: "open",
  to_fix: "in_progress",
  in_progress: "in_progress",
  fixed: "resolved",
  resolved: "resolved",
  ignored: "wont_fix",
  wont_fix: "wont_fix",
};

const FRIENDLY_STATUS: Record<string, string> = {
  open: "needs_review",
  in_progress: "to_fix",
  resolved: "fixed",
  wont_fix: "ignored",
};

export function registerBugsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_bugs",
    `List bugs found by Kery AI testing for a project, organized by triage state.

TRIAGE WORKFLOW (this is the canonical flow):
  1. After kery_run_test, the user opens the run URL and triages each bug:
     - "Mark for fix" → the agent should fix it (status='to_fix' / DB 'in_progress')
     - "Ignore"       → the agent should NOT fix it (status='ignored' / DB 'wont_fix')
  2. The agent calls this tool with status='to_fix' to get the work queue.
  3. After fixing each, the agent calls kery_update_bug with status='fixed'.

IMPORTANT — DO NOT START FIXING UNTIL THE USER HAS TRIAGED:
  • When this tool returns bugs with status='needs_review' (the default state right after a run),
    DO NOT fix them yet. Instead, share the run/bugs webUrl with the user and ask them to triage.
  • Only fix bugs the user has explicitly marked as 'to_fix'.

STATUS VALUES (user-facing → DB):
  • needs_review (open)       — just found, user hasn't decided
  • to_fix      (in_progress) — user marked for fix → agent's work queue
  • ignored     (wont_fix)    — user dismissed
  • fixed       (resolved)    — agent confirmed fix

Each bug returned includes destination_id (route) and test_id (flow) so you can filter by source.`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      status: z
        .enum([
          "needs_review", "to_fix", "ignored", "fixed", "all",
          // legacy aliases for backward compat:
          "open", "in_progress", "resolved", "wont_fix",
        ])
        .default("all")
        .describe(
          "Filter by triage state. Use 'to_fix' to get the agent's work queue, 'needs_review' to see what still needs user triage. Default: 'all'.",
        ),
      severity: z
        .enum(["high", "medium", "low", "all"])
        .default("all")
        .describe("Filter by severity. Default: 'all'."),
    },
    async ({ projectId, status, severity }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      const allBugs = await client.getBugs(projectId);

      const dbStatus = status === "all" ? null : STATUS_ALIASES[status];
      let filtered = dbStatus == null ? allBugs : allBugs.filter((b) => b.status === dbStatus);
      if (severity !== "all") filtered = filtered.filter((b) => b.severity === severity);

      const bugs = filtered.map(({ screenshotBase64, screenshotPath, ...rest }) => rest);

      // Counts across the full project (independent of filter) — used to drive nudges.
      const needsReviewCount = allBugs.filter((b) => b.status === "open").length;
      const toFixCount = allBugs.filter((b) => b.status === "in_progress").length;

      const webUrl = client.buildWebUrl(`/projects/${projectId}/bugs`);
      const nextSteps: string[] = [];

      if (needsReviewCount > 0 && (status === "all" || status === "needs_review" || status === "open")) {
        nextSteps.push(
          `⚠ ${needsReviewCount} bug(s) still need user triage. Share this URL with the user and ask them to mark each as fix or ignore: ${webUrl}`,
        );
        nextSteps.push(
          "Do NOT start fixing bugs until the user has triaged them. After the user marks bugs, call kery_get_bugs again with status='to_fix' to get the work queue.",
        );
      }

      if (status === "to_fix" || status === "in_progress") {
        if (bugs.length === 0) {
          if (needsReviewCount > 0) {
            nextSteps.push(`No bugs to fix yet. ${needsReviewCount} still awaiting user triage — share ${webUrl} with the user.`);
          } else {
            nextSteps.push("No bugs marked for fix. Ask the user if there are issues they want triaged, or run kery_run_test to find new bugs.");
          }
        } else {
          nextSteps.push(
            `${bugs.length} bug(s) marked for fix. Fix each and call kery_update_bug with status='fixed' (DB 'resolved') when done.`,
          );
          if (bugs.some((b) => b.severity === "high")) {
            nextSteps.push("Prioritize high-severity bugs first.");
          }
        }
      }

      if (status === "all" && bugs.length === 0) {
        nextSteps.push("No bugs found. Run kery_run_test to discover bugs.");
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: bugs.length,
            counts: {
              needs_review: needsReviewCount,
              to_fix: toFixCount,
              fixed: allBugs.filter((b) => b.status === "resolved").length,
              ignored: allBugs.filter((b) => b.status === "wont_fix").length,
            },
            bugs: bugs.map((b) => ({
              id: b.id,
              name: b.name,
              description: b.description,
              category: b.category,
              severity: b.severity,
              status: FRIENDLY_STATUS[b.status] ?? b.status,
              url: b.url,
              reportedAt: b.reportedAt,
              destination_id: (b as any).destination_id ?? null,
              test_id: (b as any).test_id ?? null,
            })),
            webUrl,
            nextSteps,
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_update_bug",
    `Update a bug's triage state.

WHEN TO USE:
  • Agent finished fixing a bug → status='fixed'
  • User says "ignore that one" → status='ignored'
  • Re-opening a previously triaged bug → status='needs_review'

STATUS VALUES (user-facing → DB):
  • needs_review (open)       — back to untriaged
  • to_fix      (in_progress) — user-style 'mark for fix' (rarely set by the agent)
  • ignored     (wont_fix)    — dismissed
  • fixed       (resolved)    — agent confirms fix

Get bug IDs from kery_get_bugs.`,
    {
      projectId: z.string().uuid().describe("Project ID that owns the bug"),
      bugId: z.string().uuid().describe("Bug ID to update (get from kery_get_bugs)"),
      status: z
        .enum([
          "needs_review", "to_fix", "ignored", "fixed",
          // legacy aliases:
          "open", "in_progress", "resolved", "wont_fix",
        ])
        .describe("New triage state for the bug"),
    },
    async ({ projectId, bugId, status }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      const dbStatus = STATUS_ALIASES[status];
      await client.updateBug(projectId, bugId, dbStatus);

      const messages: Record<string, string> = {
        resolved: "Bug marked as fixed. Consider re-running kery_run_test to verify the fix.",
        wont_fix: "Bug marked as ignored — excluded from future open bug counts.",
        in_progress: "Bug marked as to_fix — agent should fix this next.",
        open: "Bug reopened — needs user triage again.",
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            bugId,
            newStatus: FRIENDLY_STATUS[dbStatus] ?? dbStatus,
            message: messages[dbStatus],
            nextSteps: [messages[dbStatus]],
          }),
        }],
      };
    },
  );
}
