import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";
import { RunIntentField } from "../validation.js";

export function registerRunTestTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_run_test",
    `Run an AI browser test against a web application. The AI agent navigates the app in a real browser, takes actions, and reports any bugs found.

WHEN TO USE:
  • User says "run a test", "test my app", "check if X works", "verify the signup flow"
  • After making code changes and wanting to regression test
  • Testing a specific user flow
  • Running a saved test by ID

PREREQUISITES:
  • Kery must be running (call kery_start if needed)
  • Project must exist (call kery_setup_project first)

HOW TO PROVIDE THE TEST:
  • Use 'intent' for natural language: "verify the checkout flow completes successfully"
  • Use 'testId' to rerun a saved test (get IDs from kery_list_tests)
  • Omitting both runs a general health check of the app

TIMING & WAIT BEHAVIOR:
  • Tests take 1-5 minutes to complete.
  • By default (wait=false), this tool returns immediately with the runId and webUrl so you can hand the user a link to watch live. This is the recommended path for interactive use — share the webUrl with the user right away.
  • Set wait=true only when you need the full results inline (e.g. automated/CI flows). Then the tool blocks until the run finishes and returns bugs + summary.
  • Either way, results can be fetched later with kery_get_run using the runId.

POST-RUN TRIAGE — CRITICAL:
  After the run finishes, the bugs are in 'needs_review' state. Do NOT start fixing them immediately.
  Instead, share the run/bugs URL with the user and ask them to triage each bug (mark for fix / ignore).
  Then call kery_get_bugs with status='to_fix' to get the work queue, fix each, and call
  kery_update_bug status='fixed' when done.`,
    {
      projectId: z
        .string()
        .uuid()
        .describe("Project ID to run the test against (get from kery_setup_project or kery_list_projects)"),
      intent: RunIntentField,
      testId: z
        .string()
        .uuid()
        .optional()
        .describe("ID of a saved test to run (get from kery_list_tests)"),
      environmentId: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Environment to test against (defaults to the project's default environment). " +
          "Use this to test against staging or production instead of local dev.",
        ),
      wait: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, block until the run completes and return full results (bugs, summary, steps). " +
          "If false (default), return immediately with the runId and webUrl — share the URL with the user so they can watch the run live. " +
          "Use kery_get_run later to fetch results.",
        ),
    },
    async ({ projectId, intent, testId, environmentId, wait }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Kery is not running.",
              fix: "Call kery_start first, then retry kery_run_test.",
            }),
          }],
          isError: true,
        };
      }

      // Resolve environment
      if (!environmentId) {
        try {
          const env = await client.getDefaultEnvironment(projectId);
          environmentId = env.id;
        } catch {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "No environment configured for this project.",
                fix: "Call kery_setup_project first to create the project and a default environment.",
              }),
            }],
            isError: true,
          };
        }
      }

      try {
        const { runId } = await client.startRun(projectId, {
          environmentId,
          intent,
          testId,
        });

        if (!wait) {
          const webUrl = client.buildWebUrl(`/runs/${runId}`);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                runId,
                status: "queued",
                webUrl,
                message: `Run started. Share this URL with the user so they can watch live AND triage any bugs found: ${webUrl}`,
                nextSteps: [
                  `Share the webUrl with the user — it stays valid during and after the run.`,
                  `When the run completes, the user must triage each bug on that page (mark for fix or ignore) BEFORE you start fixing anything.`,
                  `After the user triages, call kery_get_bugs with projectId="${projectId}" and status="to_fix" to get the work queue.`,
                  `Fix each bug, then call kery_update_bug with status="fixed" to confirm.`,
                ],
              }),
            }],
          };
        }

        const run = await client.waitForRun(runId);

        const bugs = (run.bugs_json ?? []).map(({ screenshotBase64, screenshotPath, ...rest }) => rest);
        const highBugs = bugs.filter((b) => b.severity === "high");
        const medBugs = bugs.filter((b) => b.severity === "medium");

        const nextSteps: string[] = [];
        if (run.status === "passed" && bugs.length === 0) {
          nextSteps.push("Test passed with no bugs found.");
          nextSteps.push("Run more tests with different intents.");
        } else if (bugs.length > 0) {
          nextSteps.push(
            `Found ${bugs.length} bug(s)${highBugs.length > 0 ? ` (${highBugs.length} high severity)` : ""}. Call kery_get_bugs with projectId="${projectId}" to review them in detail.`,
          );
          nextSteps.push(`Call kery_get_run with runId="${run.id}" to see the full step-by-step agent trace.`);
        } else if (run.status === "failed") {
          nextSteps.push(`Test run failed. Call kery_get_run with runId="${run.id}" to see what went wrong.`);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId: run.id,
              status: run.status,
              stepsCount: (run.steps_json ?? []).length,
              bugsFound: bugs.map((b) => ({
                id: b.id,
                name: b.name,
                severity: b.severity,
                category: b.category,
                description: b.description,
                url: b.url,
              })),
              summary: run.summary ?? null,
              webUrl: client.buildWebUrl(`/runs/${run.id}`),
              nextSteps,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Test run failed: ${err instanceof Error ? err.message : String(err)}`,
              nextSteps: [
                "Make sure the app is running and accessible at the configured URL.",
                "Check kery_list_projects to verify the environment's baseUrl is correct.",
                "If auth is needed, verify credentials with kery_update_auth.",
              ],
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
