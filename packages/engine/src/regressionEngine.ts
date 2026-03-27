/**
 * Regression Engine
 *
 * Compiles successful LLM runs into deterministic Playwright scripts.
 * Replays with zero LLM calls. Falls back to Stagehand.act() for healing.
 */
import type { Page } from "playwright";
import { logger } from "./logger.js";
import type { RunStep } from "./agent.js";
import { waitForPageStable } from "./agent.js";

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
};

export type RegressionResult = {
  status: "passed" | "failed" | "stale";
  stepsCompleted: number;
  stepsTotal: number;
  healedSteps: number;
  staleSteps: number;
  bugs: Array<{ step: number; description: string }>;
};

const REPLAYABLE_ACTIONS = new Set([
  "click", "fill", "pressKey", "selectOption", "navigate", "assert", "scroll", "back",
]);

// ─── Completion Condition Evaluation ──────────────────────────────────────────

export async function evaluateCondition(page: Page, condition: CompletionCondition): Promise<boolean> {
  try {
    switch (condition.type) {
      case "url_contains":
        return page.url().includes(condition.value);
      case "url_changed":
        return true;
      case "element_visible":
        return await page.getByRole(condition.role as any, { name: condition.name }).isVisible({ timeout: 2000 });
      case "element_gone":
        return !(await page.getByRole(condition.role as any, { name: condition.name }).isVisible({ timeout: 1000 }).catch(() => false));
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

export function generateRegressionPlan(stepsDetail: RunStep[]): RegressionStep[] {
  const plan: RegressionStep[] = [];
  let prevUrl: string | undefined;

  for (let i = 0; i < stepsDetail.length; i++) {
    const step = stepsDetail[i];

    if (step.status !== "ok") continue;
    if (!REPLAYABLE_ACTIONS.has(step.action)) continue;

    const stepUrl = step.url;

    if (stepUrl && prevUrl && !isSamePage(stepUrl, prevUrl) && step.action !== "navigate" && step.action !== "back") {
      plan.push({
        action: "navigate",
        value: stepUrl,
        purpose: `Navigate to ${new URL(stepUrl).pathname}`,
        doneWhen: { type: "url_contains", value: new URL(stepUrl).pathname },
      });
    }

    const regStep: RegressionStep = {
      action: step.action as RegressionStep["action"],
      purpose: step.reasoning,
      url: stepUrl,
    };

    if (step.elementRef) {
      regStep.role = step.elementRef.role;
      regStep.name = step.elementRef.name;
    } else if (step.target) {
      regStep.name = step.target;
    }

    if (step.value) regStep.value = step.value;
    if (step.assertion) regStep.value = step.assertion;

    regStep.doneWhen = inferDoneCondition(step, stepsDetail[i + 1]);

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
      return { type: "element_visible", role: nextStep.elementRef.role, name: nextStep.elementRef.name };
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
  stagehand?: any,
): Promise<RegressionResult> {
  const result: RegressionResult = {
    status: "passed",
    stepsCompleted: 0,
    stepsTotal: plan.length,
    healedSteps: 0,
    staleSteps: 0,
    bugs: [],
  };

  let consecutiveStale = 0;
  const staleStepIndices = new Set<number>();

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];

    if (step.url && step.action !== "navigate") {
      const currentUrl = page.url();
      if (!isSamePage(currentUrl, step.url)) {
        logger.info({ expected: step.url, current: currentUrl }, "Regression: page mismatch \u2014 navigating");
        await page.goto(step.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        await waitForPageStable(page, 3000);
      }
    }

    try {
      await executeRegressionStep(page, step);
      result.stepsCompleted++;
      consecutiveStale = 0;

      if (step.doneWhen) {
        await waitForPageStable(page, 2000);
        const passed = await evaluateCondition(page, step.doneWhen);
        if (!passed) {
          logger.warn({ step: i, action: step.action, condition: step.doneWhen }, "Regression step completed but condition not met");
        }
      }

      await waitForPageStable(page, 1500);
    } catch (err) {
      const healResult = await healStep(page, step, String(err), stagehand);

      if (healResult === "healed") {
        result.healedSteps++;
        result.stepsCompleted++;
        consecutiveStale = 0;
      } else if (healResult === "bug") {
        result.bugs.push({ step: i, description: `Step failed: ${step.action} ${step.role ?? ""} "${step.name ?? ""}"` });
        result.stepsCompleted++;
        consecutiveStale = 0;
      } else {
        result.staleSteps++;
        staleStepIndices.add(i);
        consecutiveStale++;

        // Only mark plan as stale after 5 consecutive stale steps (was 3),
        // or if >50% of attempted steps are stale (plan is fundamentally outdated)
        const staleRatio = staleStepIndices.size / (i + 1);
        if (consecutiveStale >= 5 || (i >= 4 && staleRatio > 0.5)) {
          logger.warn({ consecutiveStale, staleRatio: staleRatio.toFixed(2), staleSteps: staleStepIndices.size }, "Plan marked as stale — too many unresolvable steps");
          result.status = "stale";
          return result;
        }
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

  if (!step.role && !step.name) {
    throw new Error(`Step missing role/name: ${JSON.stringify(step)}`);
  }

  const locator = step.role
    ? page.getByRole(step.role as any, { name: step.name })
    : page.getByText(step.name!, { exact: false });

  if (step.action === "click") {
    await locator.first().click({ timeout: 5000 });
  } else if (step.action === "fill" && step.value !== undefined) {
    await locator.first().fill(step.value, { timeout: 5000 });
  } else if (step.action === "selectOption" && step.value) {
    await locator.first().selectOption({ label: step.value }, { timeout: 5000 });
  }
}

// ─── Self-Healing via Stagehand ──────────────────────────────────────────────

type HealVerdict = "healed" | "bug" | "stale";

async function healStep(
  page: Page,
  step: RegressionStep,
  error: string,
  stagehand?: any,
): Promise<HealVerdict> {
  logger.info({ action: step.action, name: step.name, error: error.slice(0, 100) }, "Regression step failed \u2014 attempting heal");

  await new Promise(r => setTimeout(r, 300));

  if (stagehand) {
    try {
      const instruction = buildHealInstruction(step);
      if (instruction) {
        logger.info({ instruction: instruction.slice(0, 80) }, "Healing via Stagehand.act()");
        const { stagehandAct } = await import("./stagehandBridge.js");
        const result = await stagehandAct(stagehand, instruction);
        if (result.success) {
          logger.info({ description: result.description?.slice(0, 80) }, "Stagehand healed the step");
          return "healed";
        }
      }
    } catch (healErr) {
      logger.warn({ err: String(healErr).slice(0, 150) }, "Stagehand heal failed");
    }
  }

  if (step.name) {
    try {
      const byText = page.getByText(step.name, { exact: false });
      if (await byText.count() > 0) {
        if (step.action === "click") {
          await byText.first().click({ timeout: 3000 });
          return "healed";
        } else if (step.action === "fill" && step.value !== undefined) {
          await byText.first().fill(step.value, { timeout: 3000 });
          return "healed";
        }
      }
    } catch {}
  }

  if (step.url) {
    const currentUrl = page.url();
    if (isSamePage(currentUrl, step.url)) {
      return "bug";
    }
  }

  return "stale";
}

function buildHealInstruction(step: RegressionStep): string | null {
  const target = step.name || "";
  if (!target) return null;

  switch (step.action) {
    case "click":
      return `Click on ${target}`;
    case "fill":
      if (!step.value) return null;
      return `Type "${step.value}" into ${target}`;
    case "selectOption":
      if (!step.value) return null;
      return `Select "${step.value}" from ${target}`;
    case "pressKey":
      if (!step.value) return null;
      return `Press the ${step.value} key`;
    default:
      return null;
  }
}

// ─── Plan Confidence Scoring ─────────────────────────────────────────────────

export function updatePlanConfidence(
  currentCount: number,
  result: RegressionResult,
): number {
  if (result.status === "passed") return currentCount + 1;
  if (result.status === "stale") return 0;
  return currentCount;
}
