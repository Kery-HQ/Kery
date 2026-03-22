import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";

export function registerTestsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_list_tests",
    `List or create saved test flows for a project. Saved tests can be re-run by ID via kery_run_test. Use action 'create' to save a new test with a name and intent.`,
    {
      projectId: z.string().uuid().describe("The Kery project ID"),
      action: z.enum(["list", "create"]).default("list").describe("'list' to list tests, 'create' to create a new one"),
      name: z.string().optional().describe("Test name (required for create)"),
      intent: z.string().optional().describe("What the test checks (required for create), e.g. 'User can complete checkout'"),
      context: z.string().optional().describe("Additional context/hints for the test agent (optional)"),
    },
    async ({ projectId, action, name, intent, context }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Start it first with kery_start." }],
          isError: true,
        };
      }

      if (action === "create") {
        if (!name || !intent) {
          return {
            content: [{ type: "text", text: "Both 'name' and 'intent' are required to create a test." }],
            isError: true,
          };
        }
        const test = await client.createTest(projectId, name, intent, context);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "created",
              test: { id: test.id, name: test.name, intent: test.intent },
              message: `Test "${name}" created. Run it with kery_run_test using testId: "${test.id}"`,
            }),
          }],
        };
      }

      const tests = await client.listTests(projectId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: tests.length,
            tests: tests.map((t) => ({
              id: t.id,
              name: t.name,
              intent: t.intent,
              context: t.context,
            })),
          }),
        }],
      };
    },
  );
}
