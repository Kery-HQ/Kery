import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";
import { TestNameField, TestIntentField } from "../validation.js";

export function registerTestsTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_list_tests",
    `List or create saved, reusable test flows for a project.

WHEN TO USE:
  • User says "save this test", "create a reusable test for the checkout flow"
  • Listing saved tests to find a testId for kery_run_test
  • Building a named test suite (signup, login, checkout, settings, etc.)

ACTIONS:
  • 'list'   — returns all saved tests with IDs and intents
  • 'create' — saves a new test (name min 2 chars, intent min 3 chars)

VALIDATION:
  • name: minimum 2 characters
  • intent: minimum 3 characters — must describe what to verify

After creating, run anytime with: kery_run_test testId="<id>"`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      action: z
        .enum(["list", "create"])
        .default("list")
        .describe("'list' to list saved tests, 'create' to save a new one"),
      name: TestNameField
        .optional()
        .describe("Test name — required for create, min 2 chars (e.g. 'Checkout Flow', 'User Signup')"),
      intent: TestIntentField
        .optional()
        .describe(
          "What the test checks — required for create, min 3 chars. Examples:\n" +
          "  'User can sign up with email and reach the dashboard'\n" +
          "  'Checkout flow completes without errors'\n" +
          "  'Settings page loads and all form inputs are functional'",
        ),
      context: z
        .string()
        .nullable()
        .optional()
        .describe("Hints for the AI agent (optional). E.g. 'Use test@example.com', 'The checkout button is in the sidebar'"),
    },
    async ({ projectId, action, name, intent, context }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      if (action === "create") {
        if (!name || !intent) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Both 'name' (min 2 chars) and 'intent' (min 3 chars) are required to create a test.",
                example: {
                  action: "create",
                  name: "Checkout Flow",
                  intent: "User can complete the checkout process and receive a confirmation",
                },
              }),
            }],
            isError: true,
          };
        }
        const test = await client.createTest(projectId, name, intent, context ?? undefined);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "created",
              test: { id: test.id, name: test.name, intent: test.intent, context: test.context },
              nextSteps: [
                `Test "${name}" saved with ID: ${test.id}`,
                `Run it anytime: kery_run_test projectId="${projectId}" testId="${test.id}"`,
                `Edit it later: kery_update_test projectId="${projectId}" testId="${test.id}"`,
              ],
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
              context: t.context ?? null,
              createdAt: t.created_at,
            })),
            nextSteps:
              tests.length === 0
                ? [
                    "No saved tests yet. Create one with action='create', name, and intent.",
                    "Example: kery_list_tests action='create' name='Signup Flow' intent='User can register with email and land on the dashboard'",
                  ]
                : [`Run any test with kery_run_test testId="<id from list above>"`],
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_update_test",
    `Update a saved test's name, intent, context, or reset its regression script.

WHEN TO USE:
  • User says "rename that test", "update the test intent", "change the test description"
  • The test intent has drifted from what it actually tests
  • Resetting a regression plan after major app changes (reset_script: true)

VALIDATION:
  • name: minimum 2 characters (if provided)
  • intent: minimum 3 characters (if provided)
  • At least one field must be provided
  • Changing 'intent' automatically resets the regression script (same as reset_script: true)

Get testId from kery_list_tests.`,
    {
      projectId: z.string().uuid().describe("Project ID"),
      testId: z.string().uuid().describe("Test ID to update (get from kery_list_tests)"),
      name: TestNameField.optional().describe("New test name (min 2 chars)"),
      intent: TestIntentField.optional().describe("New test intent (min 3 chars)"),
      context: z
        .string()
        .nullable()
        .optional()
        .describe("New context/hints. Pass null to clear existing context."),
      resetScript: z
        .boolean()
        .optional()
        .describe(
          "Set true to clear the saved regression script (Playwright replay plan). " +
          "Do this after major app changes that would break the existing script. " +
          "Kery will build a new script on the next successful test run.",
        ),
    },
    async ({ projectId, testId, name, intent, context, resetScript }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      if (name === undefined && intent === undefined && context === undefined && !resetScript) {
        return {
          content: [{
            type: "text",
            text: "Provide at least one field to update: name, intent, context, or resetScript: true.",
          }],
          isError: true,
        };
      }

      const test = await client.updateTest(projectId, testId, {
        name,
        intent,
        context,
        reset_script: resetScript,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            test: { id: test.id, name: test.name, intent: test.intent, context: test.context },
            notes: [
              intent ? "Intent changed — regression script has been reset. Run the test to build a new one." : null,
              resetScript ? "Regression script cleared. Run the test again to rebuild it." : null,
            ].filter(Boolean),
            nextSteps: [`Run the updated test: kery_run_test projectId="${projectId}" testId="${testId}"`],
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_delete_test",
    `Delete a saved test permanently. The test definition is removed; past runs that used it are kept.

WHEN TO USE:
  • User says "delete that test", "remove the checkout test"
  • Cleaning up obsolete test flows

Get testId from kery_list_tests. This action is irreversible.`,
    {
      projectId: z.string().uuid().describe("Project ID"),
      testId: z.string().uuid().describe("Test ID to delete (get from kery_list_tests)"),
    },
    async ({ projectId, testId }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      await client.deleteTest(projectId, testId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            deleted: true,
            testId,
            note: "Test definition deleted. Past runs that referenced this test are unaffected.",
            nextSteps: ["Call kery_list_tests to verify the test is removed."],
          }),
        }],
      };
    },
  );
}
