#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KeryClient } from "@kery/client";

import { registerStartTools } from "./tools/start.js";
import { registerSetupTool } from "./tools/setup.js";
import { registerScanTool } from "./tools/scan.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerRunTestTool } from "./tools/run.js";
import { registerBugsTool } from "./tools/bugs.js";
import { registerCoverageTool } from "./tools/coverage.js";
import { registerRunDetailTool } from "./tools/runDetail.js";
import { registerTestsTool } from "./tools/tests.js";

const apiUrl = process.env.KERY_API_URL ?? "http://localhost:19833";
const webUrl = process.env.KERY_WEB_URL ?? "http://localhost:19834";
const apiKey = process.env.KERY_API_KEY;
const isCloud = Boolean(apiKey);

const client = new KeryClient({ apiUrl, webUrl, apiKey });

const server = new McpServer({
  name: "kery",
  version: "0.1.0",
});

// Register all tools
registerStartTools(server, client, isCloud);
registerSetupTool(server, client);
registerScanTool(server, client);
registerRouteTools(server, client);
registerRunTestTool(server, client);
registerBugsTool(server, client);
registerCoverageTool(server, client);
registerRunDetailTool(server, client);
registerTestsTool(server, client);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
