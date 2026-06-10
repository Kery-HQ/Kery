import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

export function registerDiscoverTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_discover_flows",
    `Explore a web app automatically to discover its flows and save them as reusable tests.

WHAT IT DOES:
  An AI agent navigates the app's menus, tabs, and nav bars — mapping every distinct section.
  After the run completes, the discovered flows are saved as named tests visible in kery_list_tests
  and on the Flows page in the Kery UI.

WHEN TO USE:
  • First time setting up a project — "discover what flows exist"
  • User asks "what can Kery test on my app?", "map out my app's flows"
  • After major app restructuring to re-discover changed flows

TIMING & WAIT BEHAVIOR:
  • Discovery takes 2-10 minutes depending on app complexity.
  • Returns immediately with runId and webUrl (non-blocking). Share the URL with the user.
  • If a discovery run is already in progress, returns the existing runId instead of starting a new one.
  • Call kery_get_run later to check status and see how many flows were found.

AFTER DISCOVERY:
  • Call kery_list_tests to see the discovered flows.
  • Run any discovered flow with kery_run_test testId="<id>".`,
    {
      projectId: z
        .string()
        .uuid()
        .describe("Project ID to discover flows for (get from kery_list_projects or kery_setup_project)"),
      environmentId: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Environment to explore (defaults to the project's default environment). " +
          "Use this to discover flows in staging or production.",
        ),
    },
    async ({ projectId, environmentId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Kery is not running.",
              fix: "Call kery_start first, then retry kery_discover_flows.",
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
        const { runId, alreadyRunning } = await client.discoverFlows(projectId, environmentId);
        const webUrl = client.buildWebUrl(`/runs/${runId}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              runId,
              status: alreadyRunning ? "already_running" : "queued",
              alreadyRunning,
              webUrl,
              message: alreadyRunning
                ? `A discovery run is already in progress. Share this URL with the user to watch it live: ${webUrl}`
                : `Discovery run started. Share this URL with the user so they can watch live: ${webUrl}`,
              nextSteps: [
                `Share the webUrl with the user — it shows live progress.`,
                `When the run completes, call kery_get_run with runId="${runId}" to see how many flows were discovered.`,
                `Then call kery_list_tests to see all discovered flows and run them individually.`,
              ],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Discovery run failed to start: ${err instanceof Error ? err.message : String(err)}`,
              nextSteps: [
                "Make sure the app is running and accessible at the configured URL.",
                "Call kery_list_projects to verify the environment's baseUrl is correct.",
              ],
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
