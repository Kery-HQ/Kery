#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KeryClient } from "@keryai/client";

import { registerStartTools } from "./tools/start.js";
import { registerStatusTool } from "./tools/status.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerAuthTool } from "./tools/auth.js";
import { registerScanTool } from "./tools/scan.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerRunTestTool } from "./tools/run.js";
import { registerRunsTool } from "./tools/runs.js";
import { registerRunDetailTool } from "./tools/runDetail.js";
import { registerBugsTool } from "./tools/bugs.js";
import { registerCoverageTool } from "./tools/coverage.js";
import { registerTestsTool } from "./tools/tests.js";
import { registerMemoryTool } from "./tools/memory.js";
import { registerSettingsTools } from "./tools/settings.js";

const apiUrl = process.env.KERY_API_URL ?? "http://localhost:11111";
const webUrl = process.env.KERY_WEB_URL ?? "http://localhost:11111";
const apiKey = process.env.KERY_API_KEY;
const isCloud = Boolean(apiKey);

const client = new KeryClient({ apiUrl, webUrl, apiKey });

const server = new McpServer({
  name: "kery",
  version: "0.1.0",
});

// ── Lifecycle ───────────────────────────────────────────────────────────────
registerStartTools(server, client, isCloud);

// ── Orientation ─────────────────────────────────────────────────────────────
registerStatusTool(server, client, isCloud);

// ── Project & environment management ────────────────────────────────────────
registerSetupTool(server, client);
registerProjectTools(server, client);
registerAuthTool(server, client);

// ── Discovery ───────────────────────────────────────────────────────────────
registerScanTool(server, client);
registerRouteTools(server, client);   // includes kery_update_page

// ── Testing ─────────────────────────────────────────────────────────────────
registerRunTestTool(server, client);
registerRunsTool(server, client);     // includes kery_stop_run
registerRunDetailTool(server, client);

// ── Results & triage ────────────────────────────────────────────────────────
registerBugsTool(server, client);
registerCoverageTool(server, client);

// ── Test management ─────────────────────────────────────────────────────────
registerTestsTool(server, client);    // includes kery_update_test, kery_delete_test

// ── Agent memory ─────────────────────────────────────────────────────────────
registerMemoryTool(server, client);

// ── Settings ─────────────────────────────────────────────────────────────────
registerSettingsTools(server, client);

// ── Transport ───────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
