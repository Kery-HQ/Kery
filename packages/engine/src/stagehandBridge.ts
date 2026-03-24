/**
 * Stagehand Bridge — thin wrapper around Stagehand's observe/act/extract APIs.
 */
import { Stagehand, type ObserveResult, type ActResult, type Page as StagehandPage } from "@browserbasehq/stagehand";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";

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

// ─── Circuit Breaker ────────────────────────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 2;
let _observeFailures = 0;
let _circuitOpen = false;

function recordObserveSuccess(): void {
  _observeFailures = 0;
  _circuitOpen = false;
}

function recordObserveFailure(): void {
  _observeFailures++;
  if (_observeFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitOpen = true;
    logger.warn({ failures: _observeFailures }, "Stagehand observe circuit breaker OPEN");
  }
}

export function isObserveCircuitOpen(): boolean {
  return _circuitOpen;
}

function resetCircuitBreaker(): void {
  _observeFailures = 0;
  _circuitOpen = false;
}

// ─── Init / Teardown ────────────────────────────────────────────────────────

export async function initStagehandSession(opts?: {
  recordVideo?: { dir: string; size?: { width: number; height: number } };
}): Promise<StagehandSession> {
  const model = getConfig().stagehandModel || "google/gemini-2.0-flash";

  logger.info({ model, env: "LOCAL" }, "Initializing Stagehand");

  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName: model,
    verbose: 0,
    selfHeal: true,
    domSettleTimeoutMs: 2000,
    localBrowserLaunchOptions: {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

  resetCircuitBreaker();
  logger.info("Stagehand session ready");
  return { stagehand, page };
}

export async function destroyStagehandSession(session: StagehandSession): Promise<void> {
  try {
    await session.stagehand.close();
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Stagehand close error (non-fatal)");
  }
  resetCircuitBreaker();
}

// ─── Observe ────────────────────────────────────────────────────────────────

export async function stagehandObserve(
  page: StagehandPage,
): Promise<ObservedElement[]> {
  if (_circuitOpen) return [];

  try {
    const results: ObserveResult[] = await page.observe(
      "List all interactive elements on the page: buttons, links, text inputs, checkboxes, radio buttons, select dropdowns, tabs, and any other clickable or fillable elements. Include their current state (disabled, checked, expanded, selected) and current values for form fields.",
    );

    recordObserveSuccess();
    return results.map((result, i) => ({
      id: i + 1,
      selector: result.selector,
      description: result.description,
      method: result.method,
      arguments: result.arguments,
    }));
  } catch (err) {
    recordObserveFailure();
    logger.warn({ err: String(err).slice(0, 200), failures: _observeFailures, circuitOpen: _circuitOpen }, "Stagehand observe failed");
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
