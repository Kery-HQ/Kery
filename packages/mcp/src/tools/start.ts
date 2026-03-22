import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@kery/client";
import { startDocker, stopDocker, waitForHealthy } from "../docker.js";

export function registerStartTools(server: McpServer, client: KeryClient, isCloud: boolean) {
  server.tool(
    "kery_start",
    "Start Kery testing platform (Docker containers). Only works in local mode — not needed for cloud.",
    {},
    async () => {
      if (isCloud) {
        return { content: [{ type: "text", text: "Not applicable — connected to Kery Cloud." }] };
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
            }),
          }],
        };
      }

      await startDocker();
      const healthy = await waitForHealthy(client);
      if (!healthy) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Kery started but API not responding after 30s. Check Docker logs." }) }],
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
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_stop",
    "Stop Kery testing platform (Docker containers). Only works in local mode.",
    {},
    async () => {
      if (isCloud) {
        return { content: [{ type: "text", text: "Not applicable — connected to Kery Cloud." }] };
      }

      await stopDocker();
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "stopped" }) }],
      };
    },
  );
}
