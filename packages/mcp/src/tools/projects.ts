import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

async function requireRunning(client: KeryClient) {
  const healthy = await client.checkHealth();
  if (!healthy) return "Kery is not running. Call kery_start to launch Docker, or check your connection.";
  return null;
}

export function registerProjectTools(server: McpServer, client: KeryClient) {
  // ── List projects ───────────────────────────────────────────────────────

  server.tool(
    "kery_list_projects",
    `List all Kery projects with their environments, coverage stats, and open bug counts.

WHEN TO USE:
  • You need a project ID to pass to other tools
  • User asks "what projects do I have" or "show me my kery projects"
  • Before running a test and you don't know the projectId

Returns each project's ID (needed for all other tools), environments (with auth mode and base URL), coverage summary, and open bug count.`,
    {},
    async () => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      const projects = await client.listProjects();

      if (projects.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalCount: 0,
              projects: [],
              nextSteps: ["No projects found. Call kery_setup_project to create your first project."],
            }),
          }],
        };
      }

      const enriched = await Promise.all(
        projects.map(async (p) => {
          const [envs, bugs, coverage] = await Promise.allSettled([
            client.listEnvironments(p.id),
            client.getBugs(p.id),
            client.getCoverage(p.id),
          ]);

          const envList = envs.status === "fulfilled" ? envs.value : [];
          const bugList = bugs.status === "fulfilled" ? bugs.value : [];
          const cov = coverage.status === "fulfilled" ? coverage.value : null;

          const envsWithAuth = await Promise.all(
            envList.map(async (env) => {
              const auth = await client.getAuth(p.id, env.id).catch(() => null);
              return {
                id: env.id,
                name: env.name,
                baseUrl: env.base_url,
                isDefault: env.is_default,
                authMode: auth?.mode ?? "none",
              };
            }),
          );

          const openBugs = bugList.filter((b) => b.status === "open" || b.status === "in_progress");

          return {
            id: p.id,
            name: p.name,
            domain: p.domain ?? null,
            environments: envsWithAuth,
            openBugCount: openBugs.length,
            coverage: cov
              ? {
                  total: cov.total,
                  tested: cov.tested,
                  untested: cov.untested,
                  coveragePct: cov.total > 0 ? Math.round((cov.tested / cov.total) * 100) : 0,
                }
              : null,
            webUrl: client.buildWebUrl(`/projects/${p.id}`),
          };
        }),
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalCount: enriched.length,
            projects: enriched,
            tip: "Use the 'id' field as projectId in kery_run_test, kery_scan, kery_get_bugs, etc.",
          }),
        }],
      };
    },
  );

  // ── Update project ──────────────────────────────────────────────────────

  server.tool(
    "kery_update_project",
    `Update a project's name or domain hint.

WHEN TO USE:
  • User wants to rename a project
  • User wants to update the domain used by the crawler
  • Correcting a typo in the project name

Provide projectId and whichever fields you want to change (name, domain, or both).`,
    {
      projectId: z.string().uuid().describe("Project ID to update (get from kery_list_projects)"),
      name: z.string().min(2).optional().describe("New project name"),
      domain: z
        .string()
        .optional()
        .nullable()
        .describe("Domain hint for the crawler (e.g. 'myapp.com'). Pass null to clear it."),
    },
    async ({ projectId, name, domain }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      if (name === undefined && domain === undefined) {
        return {
          content: [{ type: "text", text: "Provide at least one field to update: name or domain." }],
          isError: true,
        };
      }

      const project = await client.updateProject(projectId, { name, domain });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            project: { id: project.id, name: project.name, domain: project.domain },
            nextSteps: ["Project updated. Call kery_list_projects to verify."],
          }),
        }],
      };
    },
  );

  // ── Add environment ─────────────────────────────────────────────────────

  server.tool(
    "kery_add_environment",
    `Add a new environment (e.g. staging, production, local) to an existing project. Each environment has its own base URL and auth config. Auth for the new environment can be set with kery_update_auth after creation.

WHEN TO USE:
  • User wants to test against staging or production in addition to local dev
  • Adding a new deployment target to an existing project
  • User says "add a staging environment" or similar

After creating, call kery_update_auth to set authentication for the new environment, then kery_run_test to test against it.`,
    {
      projectId: z.string().uuid().describe("Project ID (get from kery_list_projects)"),
      name: z.string().min(2).describe("Environment name, e.g. 'Staging', 'Production', 'Local Dev'"),
      baseUrl: z
        .string()
        .url()
        .describe("Base URL of the app in this environment, e.g. 'https://staging.myapp.com'"),
      isDefault: z
        .boolean()
        .optional()
        .describe("Make this the default environment for test runs. Default: false."),
    },
    async ({ projectId, name, baseUrl, isDefault }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      const env = await client.createEnvironment(projectId, name, baseUrl, isDefault ?? false);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            created: true,
            environment: {
              id: env.id,
              name: env.name,
              baseUrl: env.base_url,
              isDefault: env.is_default,
            },
            nextSteps: [
              `Environment "${name}" created with ID: ${env.id}`,
              `Call kery_update_auth with projectId="${projectId}" and environmentId="${env.id}" to configure authentication for this environment.`,
              `Then call kery_run_test with environmentId="${env.id}" to run tests against ${baseUrl}.`,
            ],
          }),
        }],
      };
    },
  );

  // ── Update environment ──────────────────────────────────────────────────

  server.tool(
    "kery_update_environment",
    `Update an environment's name or base URL. Use this to change which URL Kery tests against (e.g. when your local dev port changes, or you want to point to a different staging URL).

WHEN TO USE:
  • User says "update the URL for my local environment" or "change the base URL"
  • The app moved to a different port or domain
  • Renaming an environment for clarity

Provide environmentId (from kery_list_projects) and whichever fields you want to change.`,
    {
      projectId: z.string().uuid().describe("Project ID"),
      environmentId: z.string().uuid().describe("Environment ID to update (visible in kery_list_projects)"),
      name: z.string().min(2).optional().describe("New environment name"),
      baseUrl: z.string().url().optional().describe("New base URL for the app in this environment"),
    },
    async ({ projectId, environmentId, name, baseUrl }) => {
      const err = await requireRunning(client);
      if (err) return { content: [{ type: "text", text: err }], isError: true };

      if (name === undefined && baseUrl === undefined) {
        return {
          content: [{ type: "text", text: "Provide at least one field to update: name or baseUrl." }],
          isError: true,
        };
      }

      const env = await client.updateEnvironment(projectId, environmentId, { name, baseUrl });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            environment: {
              id: env.id,
              name: env.name,
              baseUrl: env.base_url,
              isDefault: env.is_default,
            },
            nextSteps: [
              "Environment updated.",
              baseUrl ? `Tests will now run against ${env.base_url}. Consider running kery_scan again if the URL changed significantly.` : null,
            ].filter(Boolean),
          }),
        }],
      };
    },
  );
}
