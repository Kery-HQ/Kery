/**
 * Regression Engine
 *
 * Compiles successful LLM runs into deterministic Playwright scripts.
 * Replays with zero LLM calls. Falls back to Stagehand.act() for healing.
 */
import type { Page } from "playwright";
import { logger } from "./logger.js";
import type { RunStep, LLMCallRecord } from "./agent.js";
import { waitForPageStable } from "./agent.js";
import { healWithMicroAgent } from "./regressionHeal.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CompletionCondition =
  | { type: "url_contains"; value: string }
  | { type: "url_changed" }
  | { type: "element_visible"; role: string; name: string }
  | { type: "element_gone"; role: string; name: string }
  | { type: "text_visible"; text: string }
  | { type: "value_changed"; role: string; name: string };

export type RegressionStep = {
  action: "click" | "fill" | "pressKey" | "selectOption" | "navigate" | "assert" | "scroll" | "back" | "wait";
  role?: string;
  name?: string;
  value?: string;
  url?: string;
  doneWhen?: CompletionCondition;
  purpose?: string;
  /** After this step completes, capture the resulting page URL into this variable name for use in later steps. */
  captureUrlAs?: string;
};

export type RegressionResult = {
  status: "passed" | "failed" | "handoff";
  stepsCompleted: number;
  stepsTotal: number;
  healedSteps: number;
  bugs: Array<{ step: number; description: string }>;
  /** LLM calls made by the micro-agent healer — included in the run's llm_calls_json. */
  healCalls: LLMCallRecord[];
  /** Set when status==="handoff": the plan index where the failure occurred. */
  failedAtStep?: number;
  /** Set when status==="handoff": the resolved steps that completed before the failure. */
  completedSteps?: RegressionStep[];
};

export type RegressionLiveHooks = {
  onStep?: (step: RunStep) => void;
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer, domHash: string) => void;
  onHealCall?: (call: LLMCallRecord) => void;
};

const REPLAYABLE_ACTIONS = new Set([
  "click", "fill", "pressKey", "selectOption", "navigate", "assert", "scroll", "back",
]);

/** Substring/case-friendly name match — strict default fails on sites like HN ("Submit" vs "submit"). */
function getByRoleNamed(page: Page, role: string, name: string) {
  return page.getByRole(role as any, { name, exact: false });
}

// ─── Dynamic URL Variable Helpers ─────────────────────────────────────────────

/** Patterns that indicate dynamic/unstable URL segments (UUIDs, numeric IDs, slugs with digits). */
const DYNAMIC_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d+$/i;

/** Return true if any path segment of the URL looks dynamic. */
function hasDynamicSegment(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname.split("/").some(seg => DYNAMIC_SEGMENT_RE.test(seg));
  } catch {
    return false;
  }
}

/** Replace all dynamic segments in a URL with `{{varName/0}}`, `{{varName/1}}`, etc. */
function templateifyUrl(url: string, varName: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").map((seg, idx) =>
      DYNAMIC_SEGMENT_RE.test(seg) ? `{{${varName}/${idx}}}` : seg
    );
    u.pathname = parts.join("/");
    return u.toString();
  } catch {
    return url;
  }
}

/** Interpolate `{{varName/segmentIndex}}` placeholders from a vars map. */
function interpolate(template: string, vars: Map<string, string[]>): string {
  return template.replace(/\{\{([^/}]+)\/(\d+)\}\}/g, (_m, name, idxStr) => {
    const segs = vars.get(name);
    const idx = Number(idxStr);
    return segs?.[idx] ?? _m;
  });
}

/** Extract path segments from a live URL into the vars map. */
function captureUrlSegments(url: string, varName: string, vars: Map<string, string[]>): void {
  try {
    const { pathname } = new URL(url);
    vars.set(varName, pathname.split("/"));
  } catch {}
}

/**
 * Strip trailing counters like "3 open3 total" that sites append to link names.
 * Keeps the human-readable prefix so the locator stays specific.
 */
function sanitizeLinkName(name: string | undefined): string | undefined {
  if (!name) return name;
  // Remove patterns like "3 open3 total", "2 open1 total", etc. at end of string
  return name.replace(/\s*\d+\s+\w+(?:\d+\s+\w+)*\s*$/, "").trim() || name;
}

// ─── Completion Condition Evaluation ──────────────────────────────────────────

export async function evaluateCondition(page: Page, condition: CompletionCondition): Promise<boolean> {
  try {
    switch (condition.type) {
      case "url_contains":
        return page.url().includes(condition.value);
      case "url_changed":
        return true;
      case "element_visible":
        return await getByRoleNamed(page, condition.role, condition.name).isVisible({ timeout: 2000 });
      case "element_gone":
        return !(await getByRoleNamed(page, condition.role, condition.name).isVisible({ timeout: 1000 }).catch(() => false));
      case "text_visible":
        return await page.getByText(condition.text, { exact: false }).isVisible({ timeout: 2000 });
      case "value_changed":
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ─── Generate Regression Plan ─────────────────────────────────────────────────

function isSamePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** Element-index style "assertions" and tiny digits are not replayable as visible text. */
function isWeakAssertText(s: string | undefined): boolean {
  if (!s || !s.trim()) return true;
  const t = s.trim();
  if (/^\d{1,2}$/.test(t)) return true;
  return false;
}

/**
 * Some sites expose <select> as combobox with name = all <option> text concatenated.
 * Playwright getByRole({ name }) then fails; use first combobox fallback in execute.
 */
function sanitizeComboboxName(role: string | undefined, name: string | undefined): string | undefined {
  if (!name || role !== "combobox") return name;
  if (name.length <= 80) return name;
  const cut = name.indexOf("Name (A to Z)");
  if (cut > 0 && cut < 60) return name.slice(0, cut).trim() || name.slice(0, 60).trim();
  return name.slice(0, 60).trim();
}

/**
 * Returns false for steps that would throw immediately in executeRegressionStep.
 * Used as a final gate before pushing a step to the plan.
 */
function isExecutable(step: RegressionStep): boolean {
  switch (step.action) {
    case "navigate":
      return !!step.value;
    case "pressKey":
      return !!step.value;
    case "assert":
      return !!step.value;
    case "fill":
      return !!(step.role || step.name) && step.value !== undefined;
    case "click":
    case "selectOption":
      return !!(step.role || step.name);
    case "scroll":
    case "back":
    case "wait":
      return true;
    default:
      return false;
  }
}

export function generateRegressionPlan(stepsDetail: RunStep[]): RegressionStep[] {
  const plan: RegressionStep[] = [];
  let prevUrl: string | undefined;

  // Track which URL templates have been generated so we reuse the same var name
  // key: canonical dynamic pathname pattern → var name
  const urlVarMap = new Map<string, string>();
  let varCounter = 0;

  /** Return (or create) a variable name for a URL containing dynamic segments. */
  function varNameFor(url: string): string {
    // Use a canonical key that masks the dynamic values so any URL with the same
    // shape maps to the same variable.
    try {
      const { pathname } = new URL(url);
      const canonical = pathname.split("/").map(seg =>
        DYNAMIC_SEGMENT_RE.test(seg) ? "*" : seg
      ).join("/");
      if (!urlVarMap.has(canonical)) {
        urlVarMap.set(canonical, `url${++varCounter}`);
      }
      return urlVarMap.get(canonical)!;
    } catch {
      return `url${++varCounter}`;
    }
  }

  for (let i = 0; i < stepsDetail.length; i++) {
    const step = stepsDetail[i];

    if (step.status !== "ok") continue;
    if (!REPLAYABLE_ACTIONS.has(step.action)) continue;

    const stepUrl = step.url;

    if (stepUrl && prevUrl && !isSamePage(stepUrl, prevUrl) && step.action !== "navigate" && step.action !== "back") {
      const isDynamic = hasDynamicSegment(stepUrl);
      const navValue = isDynamic ? templateifyUrl(stepUrl, varNameFor(stepUrl)) : stepUrl;
      const navPathname = isDynamic
        ? navValue.replace(/^https?:\/\/[^/]+/, "")
        : new URL(stepUrl).pathname;
      plan.push({
        action: "navigate",
        value: navValue,
        purpose: `Navigate to ${new URL(stepUrl).pathname}`,
        doneWhen: { type: "url_contains", value: navPathname },
      });
    }

    const regStep: RegressionStep = {
      action: step.action as RegressionStep["action"],
      purpose: step.reasoning,
      url: stepUrl,
    };

    if (step.elementRef) {
      regStep.role = step.elementRef.role;
      const rawName = sanitizeComboboxName(step.elementRef.role, step.elementRef.name);
      regStep.name = step.elementRef.role === "link" ? sanitizeLinkName(rawName) : rawName;
    } else if (step.target) {
      regStep.name = step.target;
    }

    if (step.action === "assert") {
      const text = (step.assertion ?? step.target ?? "").trim();
      if (isWeakAssertText(text)) continue;
      regStep.value = text;
      regStep.role = undefined;
      regStep.name = undefined;
    } else {
      if (step.value) regStep.value = step.value;
      if (step.assertion) regStep.value = step.assertion;
    }

    if (["click", "fill", "selectOption"].includes(step.action) && !regStep.role && !regStep.name) {
      continue;
    }

    if (!isExecutable(regStep)) continue;

    regStep.doneWhen = inferDoneCondition(step, stepsDetail[i + 1]);

    // If this step (e.g. a form submission click) causes a redirect to a dynamic URL,
    // mark it so the executor captures the resulting URL for later steps.
    if (regStep.doneWhen?.type === "url_contains" && stepsDetail[i + 1]?.url) {
      const nextUrl = stepsDetail[i + 1].url!;
      if (hasDynamicSegment(nextUrl)) {
        const vname = varNameFor(nextUrl);
        regStep.captureUrlAs = vname;
        // Also template-ify the doneWhen condition so it doesn't hardcode the UUID
        const templated = templateifyUrl(nextUrl, vname);
        const templatedPath = templated.replace(/^https?:\/\/[^/]+/, "");
        regStep.doneWhen = { type: "url_contains", value: templatedPath };
      }
    }

    plan.push(regStep);
    if (stepUrl) prevUrl = stepUrl;
  }

  return plan;
}

function inferDoneCondition(step: RunStep, nextStep?: RunStep): CompletionCondition | undefined {
  if (step.action === "navigate" && step.target) {
    try {
      const pathname = new URL(step.target).pathname;
      return { type: "url_contains", value: pathname };
    } catch {}
  }

  if (step.action === "click" && step.elementRef?.role === "link" && nextStep?.url) {
    if (step.url && !isSamePage(step.url, nextStep.url)) {
      const pathname = new URL(nextStep.url).pathname;
      return { type: "url_contains", value: pathname };
    }
  }

  if (step.action === "click" && nextStep && ["fill", "selectOption"].includes(nextStep.action)) {
    if (nextStep.elementRef) {
      const nm = sanitizeComboboxName(nextStep.elementRef.role, nextStep.elementRef.name);
      return { type: "element_visible", role: nextStep.elementRef.role, name: nm ?? nextStep.elementRef.name };
    }
  }

  if (step.action === "assert" && step.assertion) {
    return { type: "text_visible", text: step.assertion };
  }

  return undefined;
}

// ─── Execute Regression Plan (Pure Playwright) ───────────────────────────────

export async function executeRegressionPlan(
  page: Page,
  plan: RegressionStep[],
  hooks: RegressionLiveHooks = {},
): Promise<RegressionResult> {
  const result: RegressionResult = {
    status: "passed",
    stepsCompleted: 0,
    stepsTotal: plan.length,
    healedSteps: 0,
    bugs: [],
    healCalls: [],
  };

  /** Steps successfully completed so far — passed to heal agent for context. */
  const completedStepsDetail: RunStep[] = [];

  /** Runtime variable store: varName → URL path segments captured after a step. */
  const vars = new Map<string, string[]>();

  /** Resolve any `{{varName/idx}}` placeholders in a string. */
  const resolve = (s: string | undefined): string | undefined =>
    s ? interpolate(s, vars) : s;

  /** Resolve placeholders inside a CompletionCondition (non-mutating). */
  function resolveCondition(cond: CompletionCondition): CompletionCondition {
    if (cond.type === "url_contains") return { ...cond, value: interpolate(cond.value, vars) };
    if (cond.type === "element_visible" || cond.type === "element_gone" || cond.type === "value_changed") {
      return { ...cond, name: interpolate(cond.name, vars) };
    }
    if (cond.type === "text_visible") return { ...cond, text: interpolate(cond.text, vars) };
    return cond;
  }

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];

    // Resolve any dynamic placeholders in this step before executing
    const resolvedStep: RegressionStep = {
      ...step,
      value: resolve(step.value),
      url: resolve(step.url),
      name: resolve(step.name),
      doneWhen: step.doneWhen ? resolveCondition(step.doneWhen) : undefined,
    };

    if (resolvedStep.url && resolvedStep.action !== "navigate" && !resolvedStep.url.includes("{{")) {
      const currentUrl = page.url();
      if (!isSamePage(currentUrl, resolvedStep.url)) {
        logger.info({ expected: resolvedStep.url, current: currentUrl }, "Regression: page mismatch \u2014 navigating");
        await page.goto(resolvedStep.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        await waitForPageStable(page, 3000);
      }
    }

    try {
      await executeRegressionStep(page, resolvedStep);
      result.stepsCompleted++;
      const at = Date.now();
      const stepRecord: RunStep = {
        index: i + 1,
        action: resolvedStep.action,
        target: resolvedStep.name,
        value: resolvedStep.value,
        reasoning: resolvedStep.purpose,
        url: page.url(),
        status: "ok",
        fromMemory: false,
        at,
        elementRef:
          resolvedStep.role && resolvedStep.name
            ? { role: resolvedStep.role, name: resolvedStep.name }
            : undefined,
      };
      completedStepsDetail.push(stepRecord);
      hooks.onStep?.(stepRecord);

      // Capture the resulting URL into a variable if requested
      if (step.captureUrlAs) {
        await waitForPageStable(page, 1500);
        captureUrlSegments(page.url(), step.captureUrlAs, vars);
        logger.info({ var: step.captureUrlAs, url: page.url() }, "Regression: captured URL variable");
      }

      if (resolvedStep.doneWhen) {
        await waitForPageStable(page, 2000);
        const passed = await evaluateCondition(page, resolvedStep.doneWhen);
        if (!passed) {
          logger.warn({ step: i, action: resolvedStep.action, condition: resolvedStep.doneWhen }, "Regression step completed but condition not met");
        }
      }

      await waitForPageStable(page, 1500);
      try {
        const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
        hooks.onScreenshot?.(screenshot, screenshot, `regression:${i + 1}:${Date.now()}`);
      } catch {
        // best effort only; replay continues even if frame capture fails
      }
    } catch (err) {
      // Pass the remaining plan so the heal agent can cover logically grouped steps.
      // onHealCall streams each call immediately as it's made (fixes streaming).
      const healResult = await healWithMicroAgent(
        page, plan, i, completedStepsDetail, hooks.onScreenshot,
        (call) => {
          result.healCalls.push(call);
          hooks.onHealCall?.(call);
        },
      );

      if (healResult.resumeFromStepIndex > i) {
        // Heal agent made progress — record healed steps and jump ahead
        const healedCount = healResult.resumeFromStepIndex - i;
        result.healedSteps += healedCount;
        result.stepsCompleted += healedCount;
        for (let h = i; h < healResult.resumeFromStepIndex; h++) {
          const hs = plan[h];
          hooks.onStep?.({
            index: h + 1,
            action: hs.action,
            target: hs.name,
            value: hs.value,
            reasoning: `${hs.purpose ?? "Step executed"} (healed)`,
            url: page.url(),
            status: "ok",
            fromMemory: false,
            at: Date.now(),
            elementRef: hs.role && hs.name ? { role: hs.role, name: hs.name } : undefined,
          });
        }
        // Capture URL variable if the last healed step needed it
        const lastHealedStep = plan[healResult.resumeFromStepIndex - 1];
        if (lastHealedStep?.captureUrlAs) {
          await waitForPageStable(page, 1500);
          captureUrlSegments(page.url(), lastHealedStep.captureUrlAs, vars);
        }
        // Jump to the resume index (loop increment will add 1)
        i = healResult.resumeFromStepIndex - 1;
      } else {
        // No progress — hand off to Navigator
        hooks.onStep?.({
          index: i + 1,
          action: resolvedStep.action,
          target: resolvedStep.name,
          value: resolvedStep.value,
          reasoning: resolvedStep.purpose,
          url: page.url(),
          status: "failed",
          error: String(err),
          fromMemory: false,
          at: Date.now(),
          elementRef: resolvedStep.role && resolvedStep.name
            ? { role: resolvedStep.role, name: resolvedStep.name }
            : undefined,
        });
        logger.warn(
          { step: i, action: step.action, name: step.name },
          "Regression: heal agent made no progress — handing off to Navigator",
        );
        result.status = "handoff";
        result.failedAtStep = i;
        result.completedSteps = plan.slice(0, i).map(s => ({
          ...s,
          value: resolve(s.value),
          url: resolve(s.url),
          name: resolve(s.name),
        }));
        return result;
      }
    }
  }

  result.status = result.bugs.length > 0 ? "failed" : "passed";
  return result;
}

async function executeRegressionStep(page: Page, step: RegressionStep): Promise<void> {
  if (step.action === "navigate" && step.value) {
    await page.goto(step.value, { waitUntil: "domcontentloaded" });
    await waitForPageStable(page, 3000);
    return;
  }

  if (step.action === "back") {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    return;
  }

  if (step.action === "wait") {
    await new Promise(r => setTimeout(r, Math.min(Number(step.value) || 1000, 5000)));
    return;
  }

  if (step.action === "pressKey" && step.value) {
    await page.keyboard.press(step.value);
    return;
  }

  if (step.action === "scroll") {
    const scrollDir = (step.value ?? "down 300").trim().toLowerCase();
    const match = scrollDir.match(/^(up|down|left|right)\s+(\d+)$/);
    if (match) {
      const dir = match[1];
      const amount = Math.min(Number(match[2]), 2000);
      const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
      const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
      await page.mouse.wheel(dx, dy);
    }
    return;
  }

  if (step.action === "assert" && step.value) {
    const visible = await page.getByText(step.value, { exact: false }).isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) throw new Error(`Assertion failed: "${step.value}" not visible`);
    return;
  }

  if (step.action === "selectOption" && step.value && step.role === "combobox") {
    const loc = step.name
      ? page.getByRole("combobox", { name: step.name, exact: false })
      : page.getByRole("combobox");
    // Try native <select> first; fall back to click-to-open + click option
    // for custom React comboboxes.
    const nativeWorked = await loc.first().selectOption({ label: step.value }, { timeout: 3000 }).then(() => true).catch(() => false);
    if (!nativeWorked) {
      await loc.first().click({ timeout: 8000 });
      await page.getByRole("option", { name: step.value, exact: false }).first().click({ timeout: 8000 });
    }
    return;
  }

  if (!step.role && !step.name) {
    throw new Error(`Step missing role/name: ${JSON.stringify(step)}`);
  }

  const locator = step.role
    ? (step.name
        ? getByRoleNamed(page, step.role, step.name)
        : page.getByRole(step.role as any))
    : page.getByText(step.name!, { exact: false });

  const actionTimeout = step.action === "click" ? 12_000 : 8_000;

  if (step.action === "click") {
    await locator.first().click({ timeout: actionTimeout });
  } else if (step.action === "fill" && step.value !== undefined) {
    await locator.first().fill(step.value, { timeout: actionTimeout });
  } else if (step.action === "selectOption" && step.value) {
    await locator.first().selectOption({ label: step.value }, { timeout: actionTimeout });
  }
}

// ─── Plan Confidence Scoring ─────────────────────────────────────────────────

export function updatePlanConfidence(
  currentCount: number,
  result: RegressionResult,
): number {
  if (result.status === "passed") return currentCount + 1;
  return currentCount;
}
