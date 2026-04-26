#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { execSync } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  const answer = await p.text({
    message: `${pc.yellow(`Port ${defaultPort} is in use`)} — enter a free port for ${label}:`,
    defaultValue: String(defaultPort + 10),
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) return "Enter a valid port (1024–65535)";
    },
  });
  if (p.isCancel(answer)) { p.outro("Cancelled."); process.exit(0); }
  return Number(answer);
}

// ─── File generation ──────────────────────────────────────────────────────────

function generateEnv(
  provider: Provider,
  apiKey: string,
  dbPort: number,
  apiPort: number,
  webPort: number,
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
    `APP_URL=http://localhost:${webPort}`,
    "RUN_TIMEOUT_MINUTES=15",
    "RECORD_VIDEO=true",
  ].join("\n");
}

function generateDockerCompose(
  provider: Provider,
  dbPort: number,
  apiPort: number,
  webPort: number,
): string {
  const cfg = PROVIDER_CONFIG[provider];
  // API key and models are read from .env by Docker Compose automatically.
  // docker-compose.yml is safe to commit; secrets stay in .env.
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
    ports:
      - "6379:6379"
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
      APP_URL: http://localhost:${webPort}
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

  web:
    image: ghcr.io/kery-hq/kery-web:latest
    ports:
      - "${webPort}:80"
    depends_on:
      - api

volumes:
  pgdata:
  appdata:
  redisdata:
`;
}

// ─── MCP helpers ─────────────────────────────────────────────────────────────

type IDE = "cursor" | "claude-code" | "codex" | "other";

function mcpServerEntry(apiPort: number, webPort: number) {
  return {
    command: "npx",
    args: ["-y", "@kery/mcp"],
    env: {
      KERY_API_URL: `http://localhost:${apiPort}`,
      KERY_WEB_URL: `http://localhost:${webPort}`,
    },
  };
}

function installCursorMcp(apiPort: number, webPort: number): boolean {
  try {
    const mcpPath = path.join(os.homedir(), ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    let config: Record<string, unknown> = {};
    if (fs.existsSync(mcpPath)) {
      try { config = JSON.parse(fs.readFileSync(mcpPath, "utf8")); } catch { /* keep empty */ }
    }
    (config as any).mcpServers ??= {};
    (config as any).mcpServers.kery = mcpServerEntry(apiPort, webPort);
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function installClaudeCodeMcp(apiPort: number, webPort: number): boolean {
  try {
    // Claude Code global MCP config lives in ~/.claude.json
    const configPath = path.join(os.homedir(), ".claude.json");
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { /* keep empty */ }
    }
    (config as any).mcpServers ??= {};
    (config as any).mcpServers.kery = mcpServerEntry(apiPort, webPort);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function manualMcpSnippet(apiPort: number, webPort: number): string {
  return JSON.stringify({ mcpServers: { kery: mcpServerEntry(apiPort, webPort) } }, null, 2);
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

// ─── Main wizard ──────────────────────────────────────────────────────────────

async function main() {
  console.log();
  p.intro(pc.bgYellow(pc.black("  Kery — AI browser testing  ")));

  // ── 1. Docker check ─────────────────────────────────────────────────────────
  const prereqSpin = p.spinner();
  prereqSpin.start("Checking prerequisites");
  const docker = checkDocker();

  if (!docker.installed) {
    prereqSpin.stop("Docker not found");
    p.log.error("Docker Desktop is required to run Kery.");
    p.log.message(`  Install it at: ${pc.cyan("https://docs.docker.com/desktop/")}`);
    p.log.message("  Once installed and running, re-run: " + pc.dim("npx create-kery"));
    p.outro("Setup cancelled.");
    process.exit(1);
  }

  if (!docker.running) {
    prereqSpin.stop("Docker found but not running");
    p.log.error("Docker Desktop is installed but not running.");
    p.log.message("  Start Docker Desktop, then re-run: " + pc.dim("npx create-kery"));
    p.outro("Setup cancelled.");
    process.exit(1);
  }

  prereqSpin.stop("Docker is ready");

  // ── 2. Provider ─────────────────────────────────────────────────────────────
  const provider = await p.select({
    message: "Which LLM provider?",
    options: (Object.entries(PROVIDER_CONFIG) as [Provider, ProviderConfig][]).map(
      ([value, cfg]) => ({ value, label: cfg.label, hint: cfg.hint }),
    ),
  }) as Provider;
  if (p.isCancel(provider)) { p.outro("Cancelled."); process.exit(0); }

  const providerCfg = PROVIDER_CONFIG[provider];

  // ── 3. API key ──────────────────────────────────────────────────────────────
  const apiKey = await p.password({
    message: `${providerCfg.label} API key`,
    validate: (v) => {
      if (!v.trim()) return "API key is required";
    },
  }) as string;
  if (p.isCancel(apiKey)) { p.outro("Cancelled."); process.exit(0); }

  // ── 4. MCP install ──────────────────────────────────────────────────────────
  const installMcp = await p.confirm({
    message: "Install Kery MCP so your AI agents can run tests directly from your IDE?",
    initialValue: true,
  });
  if (p.isCancel(installMcp)) { p.outro("Cancelled."); process.exit(0); }

  let selectedIdes: IDE[] = [];
  if (installMcp) {
    const ides = await p.multiselect({
      message: "Which IDEs?",
      options: [
        { value: "cursor",      label: "Cursor" },
        { value: "claude-code", label: "Claude Code" },
        { value: "codex",       label: "Codex CLI" },
        { value: "other",       label: "Other — show me the config snippet" },
      ],
      required: true,
    }) as IDE[];
    if (p.isCancel(ides)) { p.outro("Cancelled."); process.exit(0); }
    selectedIdes = ides;
  }

  // ── 5. Port check ───────────────────────────────────────────────────────────
  const portSpin = p.spinner();
  portSpin.start("Checking default ports (11111 · 11112 · 11113)");

  const [db11111, api11112, web11113] = await Promise.all([
    isPortFree(11111),
    isPortFree(11112),
    isPortFree(11113),
  ]);

  const allFree = db11111 && api11112 && web11113;
  portSpin.stop(allFree ? "All ports free" : "Some ports are in use — let's pick alternatives");

  let dbPort = 11111;
  let apiPort = 11112;
  let webPort = 11113;

  if (!db11111)  dbPort  = await resolvePort("Database", 11111);
  if (!api11112) apiPort = await resolvePort("API",      11112);
  if (!web11113) webPort = await resolvePort("Web UI",   11113);

  // ── 6. Write files ──────────────────────────────────────────────────────────
  const installDir = path.join(process.cwd(), "kery");
  fs.mkdirSync(installDir, { recursive: true });

  const writeSpin = p.spinner();
  writeSpin.start("Writing .env and docker-compose.yml");

  fs.writeFileSync(
    path.join(installDir, ".env"),
    generateEnv(provider, apiKey, dbPort, apiPort, webPort),
  );
  fs.writeFileSync(
    path.join(installDir, "docker-compose.yml"),
    generateDockerCompose(provider, dbPort, apiPort, webPort),
  );
  // .gitignore to protect the API key
  fs.writeFileSync(
    path.join(installDir, ".gitignore"),
    ".env\n",
  );

  writeSpin.stop(`Created ${pc.dim(installDir)}`);

  // ── 7. MCP installation ─────────────────────────────────────────────────────
  if (selectedIdes.length > 0) {
    const mcpSpin = p.spinner();
    mcpSpin.start("Installing MCP");

    const results: { label: string; ok: boolean; manual: boolean }[] = [];

    for (const ide of selectedIdes) {
      switch (ide) {
        case "cursor":
          results.push({ label: "Cursor (~/.cursor/mcp.json)", ok: installCursorMcp(apiPort, webPort), manual: false });
          break;
        case "claude-code":
          results.push({ label: "Claude Code (~/.claude.json)", ok: installClaudeCodeMcp(apiPort, webPort), manual: false });
          break;
        case "codex":
          results.push({ label: "Codex CLI", ok: false, manual: true });
          break;
        case "other":
          results.push({ label: "Other IDE", ok: false, manual: true });
          break;
      }
    }

    mcpSpin.stop("MCP step complete");

    for (const r of results) {
      if (r.manual) {
        p.log.warn(`${r.label} — add manually (snippet below)`);
      } else if (r.ok) {
        p.log.success(`${r.label}`);
      } else {
        p.log.error(`${r.label} — failed, add manually (snippet below)`);
      }
    }

    const needsManual = results.some((r) => r.manual || !r.ok);
    if (needsManual) {
      p.log.message(pc.dim("Add this block to your IDE's MCP config:"));
      p.log.message(pc.dim(manualMcpSnippet(apiPort, webPort)));
    }
  }

  // ── 8. Start Kery ───────────────────────────────────────────────────────────
  const startSpin = p.spinner();
  startSpin.start("Starting Kery with Docker (first pull may take ~1 min)");

  try {
    execSync("docker compose up -d", { cwd: installDir, stdio: "pipe" });
  } catch (err) {
    startSpin.stop("docker compose up failed");
    p.log.error("Could not start Kery. Check Docker logs:");
    p.log.message(`  cd ${pc.dim(installDir)} && docker compose logs`);
    p.outro("Setup incomplete.");
    process.exit(1);
  }

  startSpin.message("Waiting for services to be healthy...");
  const healthy = await waitForPort(apiPort, 120_000);

  if (!healthy) {
    startSpin.stop("Services are taking longer than expected");
    p.log.warn("Kery may still be starting up. Check progress with:");
    p.log.message(`  cd ${pc.dim(installDir)} && docker compose logs -f`);
  } else {
    startSpin.stop("All services healthy");
  }

  // ── 9. Done ─────────────────────────────────────────────────────────────────
  console.log();
  p.log.success(`Web dashboard  ${pc.cyan(`http://localhost:${webPort}`)}`);
  p.log.info(`API            ${pc.dim(`http://localhost:${apiPort}`)}`);
  p.log.info(`Folder         ${pc.dim(installDir)}`);
  p.log.info(`Stop           ${pc.dim(`cd kery && docker compose down`)}`);
  console.log();

  p.outro(pc.green("Opening Kery in your browser..."));

  // Dynamic import keeps 'open' from slowing startup on older Node versions
  const { default: open } = await import("open");
  await open(`http://localhost:${webPort}`).catch(() => {
    // Non-fatal — browser may not be available in CI-like environments
    p.log.warn(`Could not open browser automatically. Visit: http://localhost:${webPort}`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
