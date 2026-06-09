import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

const KERY_OVERVIEW = `Kery is an AI-powered browser testing platform. It uses LLM agents to:
  • Run AI browser agents that navigate, interact, and find bugs (kery_run_test)
  • Track bugs by severity and category (kery_get_bugs)
  • Save reusable test flows (kery_list_tests)
  • Build regression test scripts from successful runs

TYPICAL WORKFLOW:
  1. kery_start          — start the platform (local Docker mode only)
  2. kery_setup_project  — create a project with your app URL + auth config
  3. kery_run_test       — run an AI test agent with a natural language intent
  4. kery_get_bugs       — review bugs found

WHEN TO CALL kery_status:
  • The user asks "what is kery", "is kery set up", "show me my projects", or anything orientation-related
  • Before starting any workflow to understand current state
  • When you are not sure what project ID to use`;

export function registerStatusTool(server: McpServer, client: KeryClient, isCloud: boolean) {
  server.tool(
    "kery_status",
    `${KERY_OVERVIEW}

Returns full system status: whether Kery is running, all projects with their environments and auth configuration, coverage stats, open bug counts, and a recommended next-action plan. Call this first when you don't know the current state.`,
    {},
    async () => {
      const isRunning = await client.checkHealth();

      if (!isRunning) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              kery: KERY_OVERVIEW,
              connection: {
                isRunning: false,
                apiUrl: client.apiUrl,
                webUrl: client.webUrl,
                mode: isCloud ? "cloud" : "local",
              },
              projects: [],
              nextSteps: isCloud
                ? ["Kery Cloud is not reachable. Check your KERY_API_URL and KERY_API_KEY environment variables."]
                : [
                    "Kery is not running. Call kery_start to launch Docker containers.",
                    "Or run: docker compose up -d  in the kery repo directory.",
                  ],
            }),
          }],
        };
      }

      // Fetch all projects with their data in parallel
      const projects = await client.listProjects();

      const enriched = await Promise.all(
        projects.map(async (p) => {
          const [envs, bugs, overview] = await Promise.allSettled([
            client.listEnvironments(p.id),
            client.getBugs(p.id),
            client.getOverview(p.id),
          ]);

          const envList = envs.status === "fulfilled" ? envs.value : [];
          const bugList = bugs.status === "fulfilled" ? bugs.value : [];
          const ov = overview.status === "fulfilled" ? overview.value : null;

          // Fetch auth for each env
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
            totalRuns: ov?.totalRuns ?? 0,
            passRate: ov?.passRate ?? 0,
            totalCostUsd: ov?.totalCostUsd ?? 0,
            webUrl: client.buildWebUrl(`/projects/${p.id}`),
          };
        }),
      );

      // Build actionable next steps
      const nextSteps: string[] = [];
      if (enriched.length === 0) {
        nextSteps.push(
          "No projects yet. Call kery_setup_project with your app name, URL, and auth config to get started.",
        );
      } else {
        for (const p of enriched) {
          if (p.openBugCount > 0) {
            nextSteps.push(
              `Project "${p.name}" has ${p.openBugCount} open bugs. Call kery_get_bugs with projectId="${p.id}" to review them.`,
            );
          }
        }
        if (nextSteps.length === 0) {
          nextSteps.push("All projects are healthy. Run kery_run_test to test a specific flow.");
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kery: "AI-powered browser testing platform. Use kery_setup_project to add a new app, kery_run_test to run AI tests.",
            connection: {
              isRunning: true,
              apiUrl: client.apiUrl,
              webUrl: client.webUrl,
              mode: isCloud ? "cloud" : "local",
            },
            projects: enriched,
            nextSteps,
            availableTools: [
              "kery_start / kery_stop — start/stop Docker (local mode only)",
              "kery_setup_project — create or reconfigure a project + environment + auth",
              "kery_list_projects — list all projects with key info",
              "kery_update_project — rename a project or change domain",
              "kery_add_environment — add staging/prod environment to a project",
              "kery_update_environment — change environment URL or name",
              "kery_update_auth — update authentication config for an environment",
              "kery_run_test — run an AI test agent (natural language intent)",
              "kery_list_runs — list recent test runs",
              "kery_get_run — get detailed steps + bugs for a specific run",
              "kery_get_bugs — list open bugs",
              "kery_update_bug — mark bug as resolved / wont_fix / reopen",
              "kery_list_tests — list or create saved reusable test flows",
            ],
          }),
        }],
      };
    },
  );
}
