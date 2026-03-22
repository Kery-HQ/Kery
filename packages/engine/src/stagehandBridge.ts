/**
 * Stagehand Bridge — thin wrapper around Stagehand's observe/act/extract APIs.
 */
import { Stagehand, type Action, type ActResult } from "@browserbasehq/stagehand";
import { chromium, type Page, type Browser } from "playwright";
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
  browser: Browser;
  page: Page;
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

export async function initStagehandSession(): Promise<StagehandSession> {
  const model = getConfig().stagehandModel || "google/gemini-2.0-flash";

  logger.info({ model, env: "LOCAL" }, "Initializing Stagehand");

  const stagehand = new Stagehand({
    env: "LOCAL",
    model,
    verbose: 0,
    selfHeal: true,
    domSettleTimeout: 2000,
    actTimeoutMs: 10000,
    localBrowserLaunchOptions: {
      headless: true,
      viewport: { width: 1920, height: 1080 },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    logger: (line) => {
      if (line.level === 0) logger.debug({ sh: true, cat: line.category }, String(line.message));
      else if (line.level === 1) logger.info({ sh: true, cat: line.category }, String(line.message));
      else logger.warn({ sh: true, cat: line.category }, String(line.message));
    },
    disableAPI: true,
  });

  await stagehand.init();

  const cdpUrl = stagehand.connectURL();
  logger.info({ cdpUrl: cdpUrl.slice(0, 60) }, "Connecting Playwright to Stagehand browser");
  const browser = await chromium.connectOverCDP(cdpUrl);

  const contexts = browser.contexts();
  const ctx = contexts[0];
  let page: Page;
  if (ctx && ctx.pages().length > 0) {
    page = ctx.pages()[0];
  } else {
    const newCtx = ctx || await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await newCtx.newPage();
  }
  await page.setDefaultTimeout(10000);

  resetCircuitBreaker();
  logger.info("Stagehand session ready (shared browser)");
  return { stagehand, browser, page };
}

export async function destroyStagehandSession(session: StagehandSession): Promise<void> {
  try {
    await session.browser.close().catch(() => {});
  } catch {}
  try {
    await session.stagehand.close();
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Stagehand close error (non-fatal)");
  }
  resetCircuitBreaker();
}

// ─── Observe ────────────────────────────────────────────────────────────────

export async function stagehandObserve(
  stagehand: InstanceType<typeof Stagehand>,
): Promise<ObservedElement[]> {
  if (_circuitOpen) return [];

  try {
    const actions: Action[] = await stagehand.observe(
      "List all interactive elements on the page: buttons, links, text inputs, checkboxes, radio buttons, select dropdowns, tabs, and any other clickable or fillable elements. Include their current state (disabled, checked, expanded, selected) and current values for form fields.",
    );

    recordObserveSuccess();
    return actions.map((action, i) => ({
      id: i + 1,
      selector: action.selector,
      description: action.description,
      method: action.method,
      arguments: action.arguments,
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
  stagehand: InstanceType<typeof Stagehand>,
  instruction: string,
): Promise<StagehandActResult> {
  logger.info({ instruction: instruction.slice(0, 100) }, "Stagehand act");

  const result: ActResult = await stagehand.act(instruction, {
    timeout: 10000,
  });

  logger.info({
    success: result.success,
    message: result.message?.slice(0, 80),
    description: result.actionDescription?.slice(0, 80),
    cacheStatus: result.cacheStatus,
  }, "Stagehand act result");

  if (!result.success) {
    throw new Error(`Stagehand act failed: ${result.message}`);
  }

  return {
    success: result.success,
    message: result.message,
    description: result.actionDescription,
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
