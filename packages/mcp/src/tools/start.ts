import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";
import { startDocker, stopDocker, waitForHealthy } from "../docker.js";

export function registerStartTools(server: McpServer, client: KeryClient, isCloud: boolean) {
  server.tool(
    "kery_start",
    `Start the Kery testing platform via Docker. Only needed in local/self-hosted mode — not applicable for Kery Cloud.

WHEN TO USE:
  • Before any other Kery tool if Kery is not yet running
  • User says "start kery", "launch kery"
  • Another tool returns "Kery is not running"
  • After a machine restart

WHAT THIS DOES:
  • Runs 'docker compose up -d' to start the Kery API + workers + database containers
  • Waits up to 30 seconds for the API to become healthy
  • Returns the API and web dashboard URLs once ready

PREREQUISITES: Docker must be installed and running on the machine.

After starting, call kery_status to see current projects, or kery_setup_project to create a new project.`,
    {},
    async () => {
      if (isCloud) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "Connected to Kery Cloud — kery_start is not needed.",
              nextSteps: ["Call kery_status to see your cloud projects, or kery_setup_project to create a new one."],
            }),
          }],
        };
      }

      const alreadyRunning = await client.checkHealth();
      if (alreadyRunning) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "already_running",
              apiUrl: client.apiUrl,
              webUrl: client.webUrl,
              nextSteps: [
                "Kery is already running.",
                "Call kery_status to see current projects, or kery_setup_project to configure a new project.",
              ],
            }),
          }],
        };
      }

      try {
        await startDocker();
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              fix: "Make sure Docker Desktop is installed and running, then retry kery_start.",
            }),
          }],
          isError: true,
        };
      }

      const healthy = await waitForHealthy(client);
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: "Kery started but the API is not responding after 30s.",
              fix: "Check Docker logs with: docker compose logs api",
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "running",
            apiUrl: client.apiUrl,
            webUrl: client.webUrl,
            nextSteps: [
              "Kery is running.",
              "Call kery_status to see existing projects.",
              "Or call kery_setup_project to create a new project for your app.",
            ],
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_stop",
    `Stop the Kery testing platform (Docker containers). Only works in local/self-hosted mode.

WHEN TO USE:
  • User says "stop kery", "shut down kery"
  • Freeing up system resources when done testing

Runs 'docker compose down' to stop all Kery containers.`,
    {},
    async () => {
      if (isCloud) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ message: "Connected to Kery Cloud — kery_stop is not applicable." }),
          }],
        };
      }

      try {
        await stopDocker();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "stopped",
              nextSteps: ["Kery has been stopped. Call kery_start when you want to resume testing."],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
