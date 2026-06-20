import { execFile } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { promisify } from "util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionAuditResult, Environment, KeryClient } from "@keryai/client";

const execFileAsync = promisify(execFile);

type HostProbeResult = {
  status: "ok" | "failed" | "skipped";
  url: string;
  durationMs?: number;
  statusCode?: number;
  location?: string;
  error?: { code?: string; message: string };
};

type ProjectDirInspection = {
  projectDir: string;
  packageJsonFound: boolean;
  scripts: Array<{ name: string; command: string }>;
  hasExplicitHostBinding: boolean;
  error?: string;
};

type LocalPortListeners = {
  port: number;
  checked: boolean;
  command: string;
  lines: string[];
  error?: string;
};

async function requireRunning(client: KeryClient) {
  const healthy = await client.checkHealth();
  if (!healthy) return "Kery is not running. Call kery_start first, then retry the connection audit.";
  return null;
}

function serializableError(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = typeof (err as { code?: unknown }).code === "string"
      ? (err as { code?: string }).code
      : undefined;
    return { code, message: err.message };
  }
  return { message: String(err) };
}

async function probeFromMcpHost(url: string, timeoutMs = 5_000): Promise<HostProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    return { status: "failed", url, error: serializableError(err) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "skipped", url, error: { message: `Unsupported protocol: ${parsed.protocol}` } };
  }

  const transport = parsed.protocol === "https:" ? https : http;
  const started = Date.now();
  return await new Promise((resolve) => {
    const req = transport.request(parsed, {
      method: "GET",
      timeout: timeoutMs,
      headers: { "User-Agent": "Kery MCP connection audit" },
    }, (res) => {
      const location = Array.isArray(res.headers.location)
        ? res.headers.location[0]
        : res.headers.location;
      res.resume();
      res.once("end", () => resolve({
        status: "ok",
        url,
        durationMs: Date.now() - started,
        statusCode: res.statusCode,
        location,
      }));
    });
    req.once("timeout", () => {
      req.destroy(Object.assign(new Error(`Host probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    });
    req.once("error", (err) => resolve({
      status: "failed",
      url,
      durationMs: Date.now() - started,
      error: serializableError(err),
    }));
    req.end();
  });
}

function inspectProjectDir(projectDir: string | undefined): ProjectDirInspection | null {
  if (!projectDir?.trim()) return null;
  const resolved = path.resolve(projectDir.trim());
  const packagePath = path.join(resolved, "package.json");
  try {
    if (!fs.existsSync(packagePath)) {
      return {
        projectDir: resolved,
        packageJsonFound: false,
        scripts: [],
        hasExplicitHostBinding: false,
      };
    }
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = Object.entries(pkg.scripts ?? {})
      .filter(([name]) => /^(dev|start|serve|preview)(:|$)/.test(name))
      .map(([name, command]) => ({ name, command: String(command) }));
    const hasExplicitHostBinding = scripts.some(({ command }) =>
      /\b(--host|--hostname|-H)\b/.test(command) || /\b0\.0\.0\.0\b/.test(command),
    );
    return {
      projectDir: resolved,
      packageJsonFound: true,
      scripts,
      hasExplicitHostBinding,
    };
  } catch (err) {
    return {
      projectDir: resolved,
      packageJsonFound: fs.existsSync(packagePath),
      scripts: [],
      hasExplicitHostBinding: false,
      error: serializableError(err).message,
    };
  }
}

function localPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return null;
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "http:") return 80;
    if (parsed.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

async function inspectLocalPort(url: string): Promise<LocalPortListeners | null> {
  const port = localPortFromUrl(url);
  if (!port || !Number.isFinite(port)) return null;
  const args = ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"];
  try {
    const { stdout } = await execFileAsync("lsof", args, { timeout: 3_000 });
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return { port, checked: true, command: `lsof ${args.join(" ")}`, lines };
  } catch (err) {
    return {
      port,
      checked: true,
      command: `lsof ${args.join(" ")}`,
      lines: [],
      error: serializableError(err).message,
    };
  }
}

function listenerLooksLoopbackOnly(listeners: LocalPortListeners | null): boolean {
  if (!listeners?.lines.length) return false;
  const dataLines = listeners.lines.slice(1);
  if (dataLines.length === 0) return false;
  const hasWideListener = dataLines.some((line) => /\*:\d+|0\.0\.0\.0:\d+|\[::\]:\d+/.test(line));
  const hasLoopback = dataLines.some((line) => /127\.0\.0\.1:\d+|\[::1\]:\d+|localhost:\d+/.test(line));
  return hasLoopback && !hasWideListener;
}

function buildVerdict(
  audit: ConnectionAuditResult,
  hostProbe: HostProbeResult,
  listeners: LocalPortListeners | null,
): string {
  if (audit.status === "ok") return "Kery can reach the configured environment URL.";
  if (hostProbe.status === "ok") {
    return "The URL responds from the MCP host, but Kery cannot reach it from its runtime.";
  }
  if (listenerLooksLoopbackOnly(listeners)) {
    return "A local listener was found, but it appears to be listening only on loopback addresses.";
  }
  return audit.summary;
}

function buildNextSteps(
  audit: ConnectionAuditResult,
  hostProbe: HostProbeResult,
  projectDirInspection: ProjectDirInspection | null,
  listeners: LocalPortListeners | null,
): string[] {
  const nextSteps = new Set<string>(audit.recommendations);
  if (audit.status !== "ok" && hostProbe.status === "ok") {
    nextSteps.add("The app responds from this MCP process but not from Kery. Make the app reachable from the Kery runtime, then run this audit again.");
  }
  if (listenerLooksLoopbackOnly(listeners)) {
    nextSteps.add("The local listener appears loopback-only. Adjust the app server bind address or use a URL Kery can reach.");
  }
  if (audit.status !== "ok" && !projectDirInspection) {
    nextSteps.add("If you want source-level start-command context, ask the user for the app project directory and rerun this tool with projectDir.");
  }
  if (projectDirInspection && !projectDirInspection.packageJsonFound) {
    nextSteps.add("No package.json was found in projectDir. Confirm the directory points at the app root.");
  }
  if (projectDirInspection?.packageJsonFound && projectDirInspection.scripts.length === 0) {
    nextSteps.add("No common start scripts were found in package.json. Ask the user how the app server is started.");
  }
  return [...nextSteps];
}

export function registerAuditTool(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_test_connection",
    `Check whether Kery can reach a configured project environment URL and return actionable network diagnostics.

WHEN TO USE:
  - After setting up or updating project credentials
  - Before running a browser test against a new local, staging, or production URL
  - When a run fails before the app loads
  - When the user asks why Kery cannot access their app

HOW TO USE:
  - Provide projectId and, when known, environmentId.
  - If environmentId is omitted, the default project environment is checked.
  - If the check fails and the app is local, ask the user for the app project directory and rerun with projectDir for start-command context.

WHAT THIS RETURNS:
  - Kery runtime reachability result
  - Host-side probe from the MCP process
  - Local listener output when available
  - Optional package.json start-command context when projectDir is provided`,
    {
      projectId: z.string().uuid().describe("Project ID to audit (get from kery_list_projects)"),
      environmentId: z
        .string()
        .uuid()
        .optional()
        .describe("Environment ID to audit. Omit to use the project's default environment."),
      projectDir: z
        .string()
        .optional()
        .describe("Optional local app project directory. Provide it to include package.json start-command context."),
    },
    async ({ projectId, environmentId, projectDir }) => {
      const err = await requireRunning(client);
      if (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err }) }],
          isError: true,
        };
      }

      let environment: Environment;
      if (environmentId) {
        const envs = await client.listEnvironments(projectId);
        const found = envs.find((env) => env.id === environmentId);
        if (!found) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Environment not found." }) }],
            isError: true,
          };
        }
        environment = found;
      } else {
        environment = await client.getDefaultEnvironment(projectId);
        environmentId = environment.id;
      }

      const [audit, hostProbe, listeners] = await Promise.all([
        client.testConnection(projectId, environmentId),
        probeFromMcpHost(environment.base_url),
        inspectLocalPort(environment.base_url),
      ]);
      const projectDirInspection = inspectProjectDir(projectDir);
      const verdict = buildVerdict(audit, hostProbe, listeners);
      const nextSteps = buildNextSteps(audit, hostProbe, projectDirInspection, listeners);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            projectId,
            environment: {
              id: environment.id,
              name: environment.name,
              baseUrl: environment.base_url,
              isDefault: environment.is_default,
            },
            verdict,
            keryAudit: audit,
            hostProbe,
            localPortListeners: listeners,
            projectDirInspection,
            needsUserInput: audit.status !== "ok" && !projectDirInspection
              ? {
                  field: "projectDir",
                  question: "Ask the user for the local app project directory if source-level start-command context would help.",
                }
              : null,
            nextSteps,
          }),
        }],
      };
    },
  );
}
