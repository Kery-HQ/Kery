/**
 * Stagehand Bridge — thin wrapper around Stagehand's observe/act/extract APIs.
 */
import { Stagehand, type ObserveResult, type ActResult, type Page as StagehandPage } from "@browserbasehq/stagehand";
import { getConfig, type EngineConfig } from "./config.js";
import { logger } from "./logger.js";
import { dockerHostResolverArgs } from "./dockerHost.js";
import { screenshotDpr } from "./screenshotConfig.js";
import { OPENROUTER_BASE } from "./llmOpenRouter.js";
import {
  CUSTOM_MODEL_PREFIX,
  hasDirectProviderKey,
  inferModelProviderRequirement,
  wireModelForCustomEndpoint,
} from "./llmProviders.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ObservedElement = {
  id: number;
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
};

export type StagehandActResult = {
  success: boolean;
  message: string;
  description: string;
};

export type StagehandSession = {
  stagehand: InstanceType<typeof Stagehand>;
  page: StagehandPage;
};

type StagehandModelConfig = {
  modelName: string;
  modelClientOptions?: Record<string, unknown>;
  routedViaOpenRouter: boolean;
};

function directStagehandApiKey(cfg: EngineConfig, model: string): string | null {
  const req = inferModelProviderRequirement(model);
  if (req.kind !== "direct") return null;
  if (!hasDirectProviderKey(cfg, req.provider)) return null;
  switch (req.provider) {
    case "openai":
      return cfg.openaiApiKey;
    case "anthropic":
      return cfg.anthropicApiKey;
    case "gemini":
      return cfg.geminiApiKey;
  }
}

function normalizeDirectStagehandModel(model: string): string {
  const m = model.trim();
  if (m === "anthropic/claude-haiku-4.5") return "anthropic/claude-haiku-4-5";
  if (m === "claude-haiku-4.5") return "claude-haiku-4-5";
  return m;
}

function toOpenRouterModelId(model: string): string {
  const m = model.trim();
  if (m === "claude-haiku-4-5" || m === "anthropic/claude-haiku-4-5") {
    return "anthropic/claude-haiku-4.5";
  }
  if (m.startsWith("openai/") || m.startsWith("anthropic/") || m.startsWith("google/")) return m;
  if (m.startsWith("gpt-")) return `openai/${m}`;
  if (m.startsWith("claude-")) return `anthropic/${m}`;
  if (m.startsWith("gemini-")) return `google/${m}`;
  return m;
}

function customEndpointStagehandConfig(cfg: EngineConfig, model: string): StagehandModelConfig {
  return {
    // Stagehand's AI SDK route uses the first path segment as the provider; `openai/`
    // sends the call through its OpenAI-compatible client against the custom base URL.
    modelName: `openai/${wireModelForCustomEndpoint(model)}`,
    modelClientOptions: {
      apiKey: cfg.customLlmApiKey || "sk-no-key",
      baseURL: cfg.customLlmBaseUrl,
      compatibility: "compatible",
    },
    routedViaOpenRouter: false,
  };
}

function resolveStagehandModelConfig(cfg: EngineConfig, configuredModel: string): StagehandModelConfig {
  if (configuredModel.trim().startsWith(CUSTOM_MODEL_PREFIX) && cfg.customLlmBaseUrl) {
    return customEndpointStagehandConfig(cfg, configuredModel.trim());
  }

  const apiKey = directStagehandApiKey(cfg, configuredModel);
  if (apiKey) {
    return {
      modelName: normalizeDirectStagehandModel(configuredModel),
      modelClientOptions: { apiKey },
      routedViaOpenRouter: false,
    };
  }

  if (cfg.openrouterApiKey) {
    return {
      // Stagehand's AI SDK route uses the first path segment as the provider.
      // Prefix with `openai/` so OpenRouter is called through its OpenAI-compatible API
      // while preserving the actual OpenRouter model id after that first slash.
      modelName: `openai/${toOpenRouterModelId(configuredModel)}`,
      modelClientOptions: {
        apiKey: cfg.openrouterApiKey,
        baseURL: OPENROUTER_BASE,
        compatibility: "compatible",
        headers: {
          "HTTP-Referer": "https://kery.so",
          "X-Title": "Kery Agent",
        },
      },
      routedViaOpenRouter: true,
    };
  }

  if (cfg.customLlmBaseUrl) {
    return customEndpointStagehandConfig(cfg, configuredModel.trim());
  }

  return {
    modelName: normalizeDirectStagehandModel(configuredModel),
    routedViaOpenRouter: false,
  };
}

// ─── Circuit Breaker (with half-open recovery) ──────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 2;
const HALF_OPEN_DELAY_MS = 30_000; // 30s before allowing a probe request

// Circuit-breaker state is PER browser page, not per process. Workers run several
// runs concurrently in one process; a shared module-global breaker let one run's
// flaky target trip (or, via reset-on-init, wipe) the breaker for unrelated runs.
// Keying on the page object gives each run's Stagehand session its own breaker,
// garbage-collected with the page.
type BreakerState = {
  observeFailures: number;
  circuitState: "closed" | "open" | "half-open";
  circuitOpenedAt: number;
};
const _breakers = new WeakMap<object, BreakerState>();

function breakerFor(page: object): BreakerState {
  let b = _breakers.get(page);
  if (!b) {
    b = { observeFailures: 0, circuitState: "closed", circuitOpenedAt: 0 };
    _breakers.set(page, b);
  }
  return b;
}

function recordObserveSuccess(page: object): void {
  const b = breakerFor(page);
  b.observeFailures = 0;
  if (b.circuitState !== "closed") {
    logger.info("Stagehand circuit breaker CLOSED (recovered)");
  }
  b.circuitState = "closed";
}

function recordObserveFailure(page: object): void {
  const b = breakerFor(page);
  b.observeFailures++;
  if (b.circuitState === "half-open") {
    // Probe failed — back to open, reset timer
    b.circuitState = "open";
    b.circuitOpenedAt = Date.now();
    logger.warn("Stagehand half-open probe failed, circuit OPEN again");
  } else if (b.observeFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    b.circuitState = "open";
    b.circuitOpenedAt = Date.now();
    logger.warn({ failures: b.observeFailures }, "Stagehand observe circuit breaker OPEN");
  }
}

export function isObserveCircuitOpen(page: object): boolean {
  const b = breakerFor(page);
  if (b.circuitState === "open" && Date.now() - b.circuitOpenedAt >= HALF_OPEN_DELAY_MS) {
    b.circuitState = "half-open";
    logger.info("Stagehand circuit breaker HALF-OPEN (allowing probe)");
    return false; // Allow one probe request
  }
  return b.circuitState === "open";
}

// ─── Init / Teardown ────────────────────────────────────────────────────────

export async function initStagehandSession(opts?: {
  recordVideo?: { dir: string; size?: { width: number; height: number } };
}): Promise<StagehandSession> {
  const cfg = getConfig();
  const configuredModel = cfg.stagehandModel || "anthropic/claude-haiku-4.5";
  const { modelName, modelClientOptions, routedViaOpenRouter } =
    resolveStagehandModelConfig(cfg, configuredModel);

  logger.info({ model: configuredModel, stagehandModelName: modelName, routedViaOpenRouter, env: "LOCAL" }, "Initializing Stagehand");

  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName,
    modelClientOptions: modelClientOptions as any,
    verbose: 0,
    selfHeal: true,
    domSettleTimeoutMs: 2000,
    localBrowserLaunchOptions: {
      headless: true,
      deviceScaleFactor: screenshotDpr(),
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", ...dockerHostResolverArgs()],
      recordVideo: opts?.recordVideo,
    },
    logger: (line) => {
      if (line.level === 0) logger.debug({ sh: true, cat: line.category }, String(line.message));
      else if (line.level === 1) logger.info({ sh: true, cat: line.category }, String(line.message));
      else logger.warn({ sh: true, cat: line.category }, String(line.message));
    },
  });

  await stagehand.init();

  const page = stagehand.page;

  logger.info("Stagehand session ready");
  return { stagehand, page };
}

export async function destroyStagehandSession(session: StagehandSession): Promise<void> {
  try {
    await session.stagehand.close();
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Stagehand close error (non-fatal)");
  }
}

// ─── Observe ────────────────────────────────────────────────────────────────

export async function stagehandObserve(
  page: StagehandPage,
): Promise<ObservedElement[]> {
  if (isObserveCircuitOpen(page)) return [];

  try {
    const results: ObserveResult[] = await page.observe(
      "List all interactive elements on the page: buttons, links, text inputs, checkboxes, radio buttons, select dropdowns, tabs, and any other clickable or fillable elements. Include their current state (disabled, checked, expanded, selected) and current values for form fields.",
    );

    recordObserveSuccess(page);
    return results.map((result, i) => ({
      id: i + 1,
      selector: result.selector,
      description: result.description,
      method: result.method,
      arguments: result.arguments,
    }));
  } catch (err) {
    recordObserveFailure(page);
    const b = breakerFor(page);
    logger.warn(
      { err: String(err).slice(0, 200), failures: b.observeFailures, circuitState: b.circuitState },
      "Stagehand observe failed",
    );
    return [];
  }
}

export function formatObserveForLLM(elements: ObservedElement[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  const lines = elements.map((el) => `[${el.id}] ${el.description}`);
  return `Interactive elements:\n${lines.join("\n")}`;
}

export function hasSufficientObserve(elements: ObservedElement[]): boolean {
  return elements.length >= 2;
}

// ─── Act ────────────────────────────────────────────────────────────────────

export async function stagehandAct(
  page: StagehandPage,
  instruction: string,
): Promise<StagehandActResult> {
  logger.info({ instruction: instruction.slice(0, 100) }, "Stagehand act");

  const result: ActResult = await page.act({
    action: instruction,
    timeoutMs: 10000,
  });

  logger.info({
    success: result.success,
    message: result.message?.slice(0, 80),
    action: result.action?.slice(0, 80),
  }, "Stagehand act result");

  if (!result.success) {
    throw new Error(`Stagehand act failed: ${result.message}`);
  }

  return {
    success: result.success,
    message: result.message,
    description: result.action,
  };
}

export function actionToInstruction(
  action: { action: string; element?: number; target?: string; value?: string; assertion?: string },
  elements: ObservedElement[],
): string | null {
  const el = action.element != null ? elements.find((e) => e.id === action.element) : null;
  const target = el?.description || action.target || "";

  switch (action.action) {
    case "click":
      return `Click on ${target}`;
    case "fill":
      if (!action.value) return null;
      return `Type "${action.value}" into ${target}`;
    case "selectOption":
      if (!action.value) return null;
      return `Select "${action.value}" from ${target}`;
    case "pressKey":
      if (!action.value) return null;
      if (el) return `Press the ${action.value} key on ${target}`;
      return `Press the ${action.value} key`;
    case "hover":
      return `Hover over ${target}`;
    case "scroll": {
      const dir = action.value || "down 300";
      return `Scroll ${dir}`;
    }
    case "navigate":
    case "back":
    case "assert":
    case "wait":
    case "done":
      return null;
    default:
      return null;
  }
}
