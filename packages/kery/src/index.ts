#!/usr/bin/env node
import enquirer from "enquirer";
import pc from "picocolors";
import { execSync, spawn } from "child_process";
import * as readline from "readline";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Listr } from "listr2";
import gradient from "gradient-string";
import boxen from "boxen";

// ─── ASCII banner ─────────────────────────────────────────────────────────────

const BANNER_ART = [
  "+------------------------+",
  "|    _                   |",
  "|   | |_____ _ _ _  _    |",
  "|   | / / -_| '_| || |   |",
  "|   |_\\_\\___|_|  \\_, |   |",
  "|                |__/    |",
  "+------------------------+",
];

// ─── Provider defaults ────────────────────────────────────────────────────────

type Provider = "openrouter" | "openai" | "anthropic" | "gemini";

type ProviderConfig = {
  label: string;
  hint: string;
  envKey: string;
  agentModel: string;
  reviewAgentModel: string;
  auxiliaryModel: string;
  stagehandModel: string;
};

const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  openrouter: {
    label: "OpenRouter",
    hint: "Navigator: openai/gpt-4.1-mini  ·  Review: gemini-2.5-flash  ·  Support: gemini-2.5-flash",
    envKey: "OPENROUTER_API_KEY",
    agentModel: "openai/gpt-4.1-mini",
    reviewAgentModel: "gemini-2.5-flash",
    auxiliaryModel: "gemini-2.5-flash",
    stagehandModel: "google/gemini-2.0-flash",
  },
  openai: {
    label: "OpenAI",
    hint: "Navigator: gpt-4.1-mini  ·  Review: gpt-4o  ·  Support: gpt-4.1-mini",
    envKey: "OPENAI_API_KEY",
    agentModel: "openai/gpt-4.1-mini",
    reviewAgentModel: "openai/gpt-4o",
    auxiliaryModel: "openai/gpt-4.1-mini",
    stagehandModel: "openai/gpt-4o-mini",
  },
  anthropic: {
    label: "Anthropic",
    hint: "Navigator: claude-haiku-4-5  ·  Review: claude-sonnet-4-6  ·  Support: claude-haiku-4-5",
    envKey: "ANTHROPIC_API_KEY",
    agentModel: "anthropic/claude-haiku-4-5",
    reviewAgentModel: "anthropic/claude-sonnet-4-6",
    auxiliaryModel: "anthropic/claude-haiku-4-5",
    stagehandModel: "anthropic/claude-haiku-4-5",
  },
  gemini: {
    label: "Google Gemini",
    hint: "Navigator: gemini-2.5-flash  ·  Review: gemini-2.5-pro  ·  Support: gemini-2.5-flash",
    envKey: "GEMINI_API_KEY",
    agentModel: "gemini-2.5-flash",
    reviewAgentModel: "google/gemini-2.5-pro",
    auxiliaryModel: "gemini-2.5-flash",
    stagehandModel: "google/gemini-2.0-flash",
  },
};

// ─── Docker check ─────────────────────────────────────────────────────────────

function checkDocker(): { installed: boolean; running: boolean } {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch {
    return { installed: false, running: false };
  }
  try {
    execSync("docker info", { stdio: "pipe" });
    return { installed: true, running: true };
  } catch {
    return { installed: true, running: false };
  }
}

// ─── Port helpers ─────────────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function resolvePort(label: string, defaultPort: number): Promise<number> {
  const { portStr } = await enquirer.prompt<{ portStr: string }>({
    type: "input",
    name: "portStr",
    message: `${pc.yellow(`Port ${defaultPort} is in use`)} — enter a free port for ${label}:`,
    initial: String(defaultPort + 10),
    validate: (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) return "Enter a valid port (1024–65535)";
      return true;
    },
  } as never);
  return Number(portStr);
}

// ─── File generation ──────────────────────────────────────────────────────────

function generateEnv(
  provider: Provider,
  apiKey: string,
  dbPort: number,
  apiPort: number,
): string {
  const cfg = PROVIDER_CONFIG[provider];
  return [
    "# ─── Database ────────────────────────────────────────────────────────────────",
    `DATABASE_URL=postgresql://kery:kery@localhost:${dbPort}/kery`,
    "",
    "# ─── LLM key ─────────────────────────────────────────────────────────────────",
    `${cfg.envKey}=${apiKey}`,
    "",
    "# ─── Models (set by provider default — change in the UI Settings tab) ─────────",
    `AGENT_MODEL=${cfg.agentModel}`,
    `REVIEW_AGENT_MODEL=${cfg.reviewAgentModel}`,
    `AUXILIARY_MODEL=${cfg.auxiliaryModel}`,
    "",
    "# ─── Stagehand (element finder) ──────────────────────────────────────────────",
    "STAGEHAND_ENABLED=true",
    `STAGEHAND_MODEL=${cfg.stagehandModel}`,
    "",
    "# ─── Redis ───────────────────────────────────────────────────────────────────",
    "REDIS_URL=redis://localhost:6379",
    "",
    "# ─── Server ──────────────────────────────────────────────────────────────────",
    `PORT=${apiPort}`,
    `APP_URL=http://localhost:${apiPort}`,
    "RUN_TIMEOUT_MINUTES=15",
    "RECORD_VIDEO=true",
  ].join("\n");
}

function generateDockerCompose(
  provider: Provider,
  dbPort: number,
  apiPort: number,
): string {
  const cfg = PROVIDER_CONFIG[provider];
  return `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kery
      POSTGRES_PASSWORD: kery
      POSTGRES_DB: kery
    ports:
      - "${dbPort}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U kery"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    image: ghcr.io/kery-hq/kery:latest
    ports:
      - "${apiPort}:${apiPort}"
    environment:
      DATABASE_URL: postgresql://kery:kery@postgres:5432/kery
      REDIS_URL: redis://redis:6379
      PORT: ${apiPort}
      APP_URL: http://localhost:${apiPort}
      ${cfg.envKey}: \${${cfg.envKey}}
      AGENT_MODEL: ${cfg.agentModel}
      REVIEW_AGENT_MODEL: ${cfg.reviewAgentModel}
      AUXILIARY_MODEL: ${cfg.auxiliaryModel}
      STAGEHAND_ENABLED: "true"
      STAGEHAND_MODEL: ${cfg.stagehandModel}
      RUN_TIMEOUT_MINUTES: "15"
      RECORD_VIDEO: "true"
      VIDEOS_DIR: /app/data/videos
      SCREENSHOTS_DIR: /app/data/screenshots
    volumes:
      - appdata:/app/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/kery-hq/kery:latest
    command: ["node", "apps/worker/dist/worker.js"]
    environment:
      DATABASE_URL: postgresql://kery:kery@postgres:5432/kery
      REDIS_URL: redis://redis:6379
      ${cfg.envKey}: \${${cfg.envKey}}
      AGENT_MODEL: ${cfg.agentModel}
      REVIEW_AGENT_MODEL: ${cfg.reviewAgentModel}
      AUXILIARY_MODEL: ${cfg.auxiliaryModel}
      STAGEHAND_ENABLED: "true"
      STAGEHAND_MODEL: ${cfg.stagehandModel}
      RUN_TIMEOUT_MINUTES: "15"
      RECORD_VIDEO: "true"
      VIDEOS_DIR: /app/data/videos
      SCREENSHOTS_DIR: /app/data/screenshots
    volumes:
      - appdata:/app/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  pgdata:
  appdata:
  redisdata:
`;
}

// ─── MCP helpers ─────────────────────────────────────────────────────────────

type IDE = "cursor" | "claude-code" | "codex" | "other";

function mcpServerEntry(apiPort: number) {
  return {
    command: "npx",
    args: ["-y", "@keryai/mcp"],
    env: {
      KERY_API_URL: `http://localhost:${apiPort}`,
      KERY_WEB_URL: `http://localhost:${apiPort}`,
    },
  };
}

function installCursorMcp(apiPort: number): boolean {
  try {
    const mcpPath = path.join(os.homedir(), ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    let config: Record<string, unknown> = {};
    if (fs.existsSync(mcpPath)) {
      try { config = JSON.parse(fs.readFileSync(mcpPath, "utf8")); } catch { /* keep empty */ }
    }
    (config as Record<string, Record<string, unknown>>).mcpServers ??= {};
    (config as Record<string, Record<string, unknown>>).mcpServers["kery"] = mcpServerEntry(apiPort);
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function installClaudeCodeMcp(apiPort: number): boolean {
  try {
    const configPath = path.join(os.homedir(), ".claude.json");
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { /* keep empty */ }
    }
    (config as Record<string, Record<string, unknown>>).mcpServers ??= {};
    (config as Record<string, Record<string, unknown>>).mcpServers["kery"] = mcpServerEntry(apiPort);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function manualMcpSnippet(apiPort: number): string {
  return JSON.stringify({ mcpServers: { kery: mcpServerEntry(apiPort) } }, null, 2);
}

// ─── Slash command (/kery) ──────────────────────────────────────────────────

function slashCommandBody(opts: { withFrontmatter: boolean }): string {
  const body = `You are helping the user interact with Kery — an AI browser testing platform that drives a real browser to test web apps and report bugs.

The user invoked \`/kery\` with this intent:

> $ARGUMENTS

Figure out what they want and call the right Kery MCP tool. The Kery MCP tools are all prefixed \`mcp__kery__kery_*\`. Common ones:

- \`kery_start\` / \`kery_stop\` / \`kery_status\` — manage the local Kery platform
- \`kery_list_projects\` / \`kery_setup_project\` / \`kery_update_project\` — projects
- \`kery_list_routes\` / \`kery_scan\` — discover pages in the app
- \`kery_list_tests\` / \`kery_run_test\` / \`kery_update_test\` / \`kery_delete_test\` — tests
- \`kery_list_runs\` / \`kery_get_run\` / \`kery_stop_run\` — run history & results
- \`kery_get_bugs\` / \`kery_update_bug\` — bug triage
- \`kery_get_coverage\` — coverage report
- \`kery_get_settings\` / \`kery_update_settings\` / \`kery_update_auth\` / \`kery_add_environment\` / \`kery_update_environment\` / \`kery_update_page\` — configuration

Rules:
1. If a Kery tool returns "Kery is not running", call \`kery_start\` first and retry.
2. If no project exists yet, call \`kery_list_projects\` to check, then \`kery_setup_project\` if needed.
3. For "test the X flow" / "run a test" / "check if Y works": call \`kery_run_test\` with the user's intent. **By default it returns immediately with a \`webUrl\` — share that URL with the user right away so they can watch the run live. Do not wait for the run to finish unless the user explicitly asks for inline results (then pass \`wait: true\`).**
4. Be terse. Show the user the relevant URL or result and stop — don't narrate the tool sequence.
`;
  if (!opts.withFrontmatter) return body;
  return `---
description: Interact with Kery — run AI browser tests, check status, view bugs
argument-hint: <what you want Kery to do>
allowed-tools: mcp__kery__*, Bash
---

${body}`;
}

function installClaudeCodeSlashCommand(): boolean {
  try {
    const cmdPath = path.join(os.homedir(), ".claude", "commands", "kery.md");
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
    fs.writeFileSync(cmdPath, slashCommandBody({ withFrontmatter: true }));
    return true;
  } catch {
    return false;
  }
}

function installCodexSlashCommand(): boolean {
  try {
    const cmdPath = path.join(os.homedir(), ".codex", "prompts", "kery.md");
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
    fs.writeFileSync(cmdPath, slashCommandBody({ withFrontmatter: false }));
    return true;
  } catch {
    return false;
  }
}

// ─── Codex MCP (TOML) ───────────────────────────────────────────────────────

function codexMcpTomlBlock(apiPort: number): string {
  return [
    "[mcp_servers.kery]",
    'command = "npx"',
    'args = ["-y", "@keryai/mcp"]',
    "",
    "[mcp_servers.kery.env]",
    `KERY_API_URL = "http://localhost:${apiPort}"`,
    `KERY_WEB_URL = "http://localhost:${apiPort}"`,
    "",
  ].join("\n");
}

function installCodexMcp(apiPort: number): boolean {
  try {
    const cfgPath = path.join(os.homedir(), ".codex", "config.toml");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const block = codexMcpTomlBlock(apiPort);
    let existing = "";
    if (fs.existsSync(cfgPath)) {
      existing = fs.readFileSync(cfgPath, "utf8");
    }
    // Strip any existing [mcp_servers.kery] or [mcp_servers.kery.*] tables
    // (everything from such a header until the next top-level [section] or EOF).
    const stripped = existing
      .split(/\r?\n/)
      .reduce<{ out: string[]; skipping: boolean }>(
        (acc, line) => {
          const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
          if (headerMatch) {
            const name = headerMatch[1].trim();
            if (name === "mcp_servers.kery" || name.startsWith("mcp_servers.kery.")) {
              acc.skipping = true;
              return acc;
            }
            acc.skipping = false;
          }
          if (!acc.skipping) acc.out.push(line);
          return acc;
        },
        { out: [], skipping: false },
      )
      .out.join("\n");
    const sep = stripped.length === 0 || stripped.endsWith("\n\n") ? "" : stripped.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(cfgPath, stripped + sep + block);
    return true;
  } catch {
    return false;
  }
}

// ─── Wait for API ─────────────────────────────────────────────────────────────

async function waitForPort(port: number, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.setTimeout(1500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (reachable) return true;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

// ─── Spawn helper ─────────────────────────────────────────────────────────────

interface SpawnOpts {
  onLine?: (line: string) => void;
  verbose?: boolean;
}

function spawnProcess(
  cmd: string,
  args: string[],
  cwd: string,
  opts: SpawnOpts = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: opts.verbose ? "inherit" : "pipe",
      env: { ...process.env },
    });

    if (!opts.verbose && child.stdin) {
      child.stdin.end();
    }

    if (!opts.verbose && child.stdout && child.stderr) {
      const onLine = (line: string) => {
        if (opts.onLine && line.trim()) opts.onLine(line.trim());
      };
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
      readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", onLine);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker exited with code ${code}`));
    });
  });
}

// ─── Docker output parser ─────────────────────────────────────────────────────

interface DockerPullState {
  services: Map<string, "pulling" | "done">;
}

function parseDockerLine(line: string, state: DockerPullState): string | null {
  if (/Pulling|pulling from/i.test(line)) {
    const m = line.match(/(\w[\w-]*)\s+(?:Pulling|pulling from)/i);
    if (m) {
      state.services.set(m[1], "pulling");
      return formatDockerStatus(state);
    }
  }
  if (/Pulled|DONE/i.test(line)) {
    const m = line.match(/(\w[\w-]*)\s+(?:Pulled|DONE)/i);
    if (m && state.services.has(m[1])) {
      state.services.set(m[1], "done");
      return formatDockerStatus(state);
    }
  }
  const rm = line.match(/\[\+\] Running (\d+)\/(\d+)/);
  if (rm) return `Starting services (${rm[1]}/${rm[2]} ready)`;
  return null;
}

function formatDockerStatus(state: DockerPullState): string {
  const pulling = [...state.services.entries()].filter(([, v]) => v === "pulling").map(([k]) => k);
  const done = [...state.services.entries()].filter(([, v]) => v === "done").map(([k]) => k);
  const parts: string[] = [];
  if (pulling.length) parts.push(`Pulling: ${pulling.join(", ")}`);
  if (done.length) parts.push(`Done: ${done.join(", ")}`);
  return parts.join("  ·  ") || "Preparing containers…";
}

// ─── Banner + success box ─────────────────────────────────────────────────────

function printBanner(): void {
  const logo = gradient(["#F5A623", "#E8520A"]);

  console.log();
  for (const line of BANNER_ART) {
    console.log("  " + logo(line));
  }
  console.log();
  console.log("  " + pc.bold(logo("Ship Fast, Break Nothing.")));
  console.log();
}

function buildSuccessBox(
  apiPort: number,
  installDir: string,
  mcpResults: { label: string; ok: boolean; manual: boolean }[],
): string {
  const lines = [
    pc.bold("Kery is ready!"),
    "",
    `  Dashboard  ${pc.cyan(`http://localhost:${apiPort}`)}`,
    `  Folder     ${pc.dim(installDir)}`,
    `  Stop       ${pc.dim(`cd ${installDir} && docker compose down`)}`,
  ];

  const needsManual = mcpResults.some((r) => r.manual || !r.ok);
  if (needsManual) {
    lines.push("");
    lines.push(pc.yellow("  MCP config — add manually to your IDE:"));
    lines.push(pc.dim(manualMcpSnippet(apiPort)));
  }

  return boxen(lines.join("\n"), {
    padding: 1,
    borderStyle: "round",
    borderColor: "yellow",
  });
}

// ─── Task context ─────────────────────────────────────────────────────────────

interface TaskCtx {
  installDir: string;
  dbPort: number;
  apiPort: number;
  provider: Provider;
  apiKey: string;
  selectedIdes: IDE[];
  mcpResults: { label: string; ok: boolean; manual: boolean }[];
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  process.on("SIGINT", () => { console.log("\n" + pc.dim("  Cancelled.")); process.exit(0); });

  printBanner();

  try {
    // ── 1. Provider ───────────────────────────────────────────────────────────
    const { provider } = await enquirer.prompt<{ provider: Provider }>({
      type: "select",
      name: "provider",
      message: "Which LLM provider?",
      choices: (Object.entries(PROVIDER_CONFIG) as [Provider, ProviderConfig][]).map(
        ([name, cfg]) => ({
          name,
          message: name === "openrouter" ? cfg.label + "  (recommended)" : cfg.label,
        }),
      ),
    } as never);

    const providerCfg = PROVIDER_CONFIG[provider];

    // ── 2. API key ────────────────────────────────────────────────────────────
    const { apiKey } = await enquirer.prompt<{ apiKey: string }>({
      type: "password",
      name: "apiKey",
      message: `${providerCfg.label} API key`,
      validate: (v: string) => v.trim() ? true : "API key is required",
    } as never);

    // ── 3. MCP install ────────────────────────────────────────────────────────
    const { installMcp } = await enquirer.prompt<{ installMcp: boolean }>({
      type: "confirm",
      name: "installMcp",
      message: "Install Kery MCP so your AI agents can run tests directly from your IDE?",
      initial: true,
    } as never);

    let selectedIdes: IDE[] = [];
    if (installMcp) {
      const { ides } = await enquirer.prompt<{ ides: string[] }>({
        type: "multiselect",
        name: "ides",
        message: "Which IDEs?  (space to select · enter to submit)",
        choices: [
          { name: "cursor",      message: "Cursor" },
          { name: "claude-code", message: "Claude Code" },
          { name: "codex",       message: "Codex CLI" },
          { name: "other",       message: "Other — show me the config snippet" },
        ],
      } as never);
      selectedIdes = ides as IDE[];
    }

    // ── 4. Port check ─────────────────────────────────────────────────────────
    const [dash11111, db11112] = await Promise.all([
      isPortFree(11111),
      isPortFree(11112),
    ]);

    if (!dash11111 || !db11112) {
      console.log(pc.yellow("  ⚠ Some default ports are in use — let's pick alternatives"));
    }

    let apiPort = 11111;
    let dbPort  = 11112;

    if (!dash11111) apiPort = await resolvePort("Dashboard", 11111);
    if (!db11112)   dbPort  = await resolvePort("Database",  11112);

    // ── 5. Build context ──────────────────────────────────────────────────────
    const installDir = path.resolve(
      process.cwd() === "/" ? os.homedir() : process.cwd(),
      "kery",
    );

    const ctx: TaskCtx = {
      installDir,
      dbPort,
      apiPort,
      provider,
      apiKey,
      selectedIdes,
      mcpResults: [],
    };

    console.log(); // spacer before task list

    // ── 6. Task list ──────────────────────────────────────────────────────────
    const tasks = new Listr<TaskCtx, "default", "verbose">([
      {
        title: "Check Docker",
        task: (_, task) => {
          const docker = checkDocker();
          if (!docker.installed) {
            throw new Error("Docker Desktop not found. Install at https://docs.docker.com/desktop/");
          }
          if (!docker.running) {
            throw new Error("Docker is not running — start Docker Desktop first");
          }
          task.title = pc.yellow("Docker is ready");
        },
      },
      {
        title: "Check ports",
        task: (taskCtx, task) => {
          task.title = pc.yellow(`Ports assigned  db:${taskCtx.dbPort}  dashboard:${taskCtx.apiPort}`);
        },
      },
      {
        title: "Write config files",
        task: (taskCtx, task) => {
          fs.mkdirSync(taskCtx.installDir, { recursive: true });
          fs.writeFileSync(
            path.join(taskCtx.installDir, ".env"),
            generateEnv(taskCtx.provider, taskCtx.apiKey, taskCtx.dbPort, taskCtx.apiPort),
          );
          fs.writeFileSync(
            path.join(taskCtx.installDir, "docker-compose.yml"),
            generateDockerCompose(taskCtx.provider, taskCtx.dbPort, taskCtx.apiPort),
          );
          fs.writeFileSync(path.join(taskCtx.installDir, ".gitignore"), ".env\n");
          task.title = pc.yellow(verbose
            ? `Config written → ${taskCtx.installDir}`
            : "Config files written");
        },
      },
      {
        title: "Install MCP",
        enabled: (taskCtx) => taskCtx.selectedIdes.length > 0,
        task: (taskCtx, task) => {
          for (const ide of taskCtx.selectedIdes) {
            switch (ide) {
              case "cursor":
                taskCtx.mcpResults.push({
                  label: "Cursor (~/.cursor/mcp.json)",
                  ok: installCursorMcp(taskCtx.apiPort),
                  manual: false,
                });
                break;
              case "claude-code": {
                const mcpOk = installClaudeCodeMcp(taskCtx.apiPort);
                const cmdOk = installClaudeCodeSlashCommand();
                taskCtx.mcpResults.push({
                  label: `Claude Code (~/.claude.json${cmdOk ? " + /kery slash command" : ""})`,
                  ok: mcpOk,
                  manual: false,
                });
                break;
              }
              case "codex": {
                const mcpOk = installCodexMcp(taskCtx.apiPort);
                const cmdOk = installCodexSlashCommand();
                taskCtx.mcpResults.push({
                  label: `Codex CLI (~/.codex/config.toml${cmdOk ? " + /kery prompt" : ""})`,
                  ok: mcpOk,
                  manual: !mcpOk,
                });
                break;
              }
              case "other":
                taskCtx.mcpResults.push({ label: "Other IDE", ok: false, manual: true });
                break;
            }
          }
          const ok = taskCtx.mcpResults.filter((r) => r.ok).map((r) => r.label).join(", ");
          task.title = pc.yellow(ok ? `MCP installed → ${ok}` : "MCP install (manual config needed)");
        },
      },
      {
        title: "Pull & start Kery  (first run: image pull may take 1–2 min)",
        task: async (taskCtx, task) => {
          const state: DockerPullState = { services: new Map() };
          const dockerArgs = ["compose", "up", "-d"];

          await spawnProcess("docker", dockerArgs, taskCtx.installDir, {
            verbose,
            onLine: verbose
              ? undefined
              : (line) => {
                  const status = parseDockerLine(line, state);
                  if (status) task.output = status;
                },
          });
          task.title = pc.yellow("Containers started");
        },
      },
      {
        title: "Wait for API to be healthy",
        task: async (taskCtx, task) => {
          const start = Date.now();
          const tick = setInterval(() => {
            const elapsed = Math.round((Date.now() - start) / 1000);
            task.output = `${elapsed}s — waiting for API on :${taskCtx.apiPort}`;
          }, 1000);

          const healthy = await waitForPort(taskCtx.apiPort, 120_000);
          clearInterval(tick);

          if (healthy) {
            task.title = pc.yellow("API is healthy");
          } else {
            task.title = pc.yellow("API health check timed out — services may still be starting");
          }
        },
      },
    ],
    {
      renderer: "default",
      fallbackRenderer: "verbose",
      fallbackRendererCondition: () => verbose,
      rendererOptions: { collapseSubtasks: false },
    },
    );

    try {
      await tasks.run(ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("\n" + pc.red("Setup failed: ") + msg);
      if (!verbose) {
        console.error(pc.dim("Run with --verbose for full docker output"));
      }
      process.exit(1);
    }

    // ── 7. Done ───────────────────────────────────────────────────────────────
    console.log("\n" + buildSuccessBox(ctx.apiPort, ctx.installDir, ctx.mcpResults));

    const { default: open } = await import("open");
    await open(`http://localhost:${ctx.apiPort}`).catch(() => {
      console.log(pc.dim(`  Could not open browser — visit http://localhost:${ctx.apiPort}`));
    });

  } catch {
    console.log("\n" + pc.dim("  Cancelled."));
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
