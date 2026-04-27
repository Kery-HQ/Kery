import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";
import {
  MemoryTypeField,
  MemorySummaryField,
  MemoryContentField,
  MemoryConfidenceField,
} from "../validation.js";

export function registerMemoryTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_memory",
    `Manage the AI agent memory for a project. Memory entries teach Kery about your app's quirks — navigation paths, regions to ignore, known false-positive bugs, and tips.

WHEN TO USE:
  • User says "teach kery to ignore the cookie banner", "tell kery to avoid the delete button", "add a tip about the login flow"
  • After a test run finds false positives — add a 'bug_pattern' to suppress them
  • The agent keeps getting confused by a modal or overlay — add an 'ignore_region'
  • Kery can't find a page — add a 'learned_path' with navigation steps
  • Listing memory to review what the agent knows

MEMORY TYPES (enforced by API):
  'learned_path'   — navigation sequence Kery should follow (e.g. "Click 'Get Started', then 'Dashboard'")
  'ignore_region'  — UI area to skip during visual inspection (e.g. "The bottom-right cookie consent banner")
  'avoid_region'   — UI element to never interact with (e.g. "The red 'Delete All Data' button in settings")
  'bug_pattern'    — known false-positive to filter out (e.g. "The blinking cursor in text inputs is not a bug")
  'tip'            — general agent hint (e.g. "The sidebar collapses at mobile breakpoints")

ACTIONS: list | create | update | delete
  • list   — returns all memory entries for the project
  • create — adds a new entry (type, summary, content required; confidence 0-100 optional)
  • update — patches an existing entry by entryId (at least one field required)
  • delete — removes an entry by entryId (irreversible)

VALIDATION:
  • type: must be one of the 5 memory types above
  • summary: min 1 character (shown in list views)
  • content: min 1 character (read by the agent during runs)
  • confidence: integer 0-100 (default 50; higher = more weight)`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      action: z
        .enum(["list", "create", "update", "delete"])
        .default("list")
        .describe("'list' all, 'create' new entry, 'update' existing, 'delete' by entryId"),
      entryId: z
        .string()
        .uuid()
        .optional()
        .describe("Memory entry ID — required for update and delete (get from action='list')"),
      type: MemoryTypeField.optional().describe("Required for create"),
      summary: MemorySummaryField.optional().describe("Short one-liner — required for create"),
      content: MemoryContentField.optional().describe("Detailed content the agent reads — required for create"),
      confidence: MemoryConfidenceField,
      region: z
        .object({
          description: z
            .string()
            .min(1, "Region description is required")
            .describe("Human-readable description of the UI region, e.g. 'The cookie consent banner at the bottom-right'"),
        })
        .nullable()
        .optional()
        .describe("UI region descriptor for ignore_region and avoid_region types. Pass null to clear."),
    },
    async ({ projectId, action, entryId, type, summary, content, confidence, region }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      if (action === "list") {
        const entries = await client.listMemory(projectId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalCount: entries.length,
              entries: entries.map((e: any) => ({
                id: e.id,
                type: e.type,
                summary: e.summary,
                content: e.content,
                confidence: e.confidence,
                region: e.region ?? null,
                source: e.source,
                createdAt: e.created_at,
                updatedAt: e.updated_at,
              })),
              nextSteps:
                entries.length === 0
                  ? ["No memory entries yet. Add entries to help the agent navigate your app."]
                  : [`Manage entries with action='update' or action='delete' using an entry's id.`],
            }),
          }],
        };
      }

      if (action === "create") {
        if (!type || !summary || !content) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "type, summary, and content are all required to create a memory entry.",
                validTypes: ["learned_path", "ignore_region", "avoid_region", "bug_pattern", "tip"],
                example: {
                  action: "create",
                  type: "ignore_region",
                  summary: "Cookie consent banner",
                  content: "There is a cookie consent banner in the bottom-right corner. Do not flag it as a bug and do not interact with it.",
                  confidence: 90,
                },
              }),
            }],
            isError: true,
          };
        }
        const entry = await client.createMemoryEntry(projectId, {
          type,
          summary,
          content,
          confidence,
          region: region ?? undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              created: true,
              entry: { id: entry.id, type: entry.type, summary: entry.summary, confidence: entry.confidence },
              nextSteps: [
                `Memory entry added. It will take effect on the next test run.`,
                `Call kery_run_test to see it in action.`,
              ],
            }),
          }],
        };
      }

      if (action === "update") {
        if (!entryId) {
          return {
            content: [{ type: "text", text: "entryId is required for update. Get it from action='list'." }],
            isError: true,
          };
        }
        if (type === undefined && summary === undefined && content === undefined && confidence === undefined && region === undefined) {
          return {
            content: [{ type: "text", text: "Provide at least one field to update: type, summary, content, confidence, or region." }],
            isError: true,
          };
        }
        const entry = await client.updateMemoryEntry(projectId, entryId, {
          type,
          summary,
          content,
          confidence,
          region,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              updated: true,
              entry: { id: entry.id, type: entry.type, summary: entry.summary, confidence: entry.confidence },
              nextSteps: ["Memory updated. Changes take effect on the next test run."],
            }),
          }],
        };
      }

      // delete
      if (!entryId) {
        return {
          content: [{ type: "text", text: "entryId is required for delete. Get it from action='list'." }],
          isError: true,
        };
      }
      await client.deleteMemoryEntry(projectId, entryId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            deleted: true,
            entryId,
            nextSteps: ["Memory entry removed. Call action='list' to verify."],
          }),
        }],
      };
    },
  );
}
