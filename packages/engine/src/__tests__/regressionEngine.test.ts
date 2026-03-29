/**
 * Tests for regressionEngine — generateRegressionPlan()
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateRegressionPlan } from "../regressionEngine.js";
import type { RunStep } from "../agent.js";

function makeStep(overrides: Partial<RunStep>): RunStep {
  return {
    index: 1,
    action: "click",
    status: "ok",
    fromMemory: false,
    url: "http://app.test/page",
    ...overrides,
  };
}

describe("generateRegressionPlan", () => {
  it("produces a plan from successful steps", () => {
    const steps: RunStep[] = [
      makeStep({ index: 1, action: "navigate", target: "http://app.test/login", url: "http://app.test/login" }),
      makeStep({ index: 2, action: "fill", target: "Email", value: "a@b.com", url: "http://app.test/login", elementRef: { role: "textbox", name: "Email" } }),
      makeStep({ index: 3, action: "click", target: "Submit", url: "http://app.test/login", elementRef: { role: "button", name: "Submit" } }),
      makeStep({ index: 4, action: "done", url: "http://app.test/dashboard" }),
    ];
    const plan = generateRegressionPlan(steps);
    assert.ok(plan.length >= 2, "Plan should have at least 2 steps");
    assert.strictEqual(plan[0].action, "navigate");
    assert.strictEqual(plan[1].action, "fill");
  });

  it("skips failed steps", () => {
    const steps: RunStep[] = [
      makeStep({ index: 1, action: "click", status: "failed", target: "Broken" }),
      makeStep({ index: 2, action: "click", status: "ok", target: "Working", elementRef: { role: "button", name: "Working" } }),
    ];
    const plan = generateRegressionPlan(steps);
    assert.ok(plan.every(s => s.name !== "Broken"), "Failed steps should be skipped");
  });

  it("returns empty plan for no replayable steps", () => {
    const steps: RunStep[] = [
      makeStep({ index: 1, action: "done" }),
    ];
    const plan = generateRegressionPlan(steps);
    assert.strictEqual(plan.length, 0);
  });

  it("inserts navigate steps on page transitions", () => {
    const steps: RunStep[] = [
      makeStep({ index: 1, action: "click", url: "http://app.test/page1", elementRef: { role: "button", name: "Save" } }),
      makeStep({ index: 2, action: "click", url: "http://app.test/page2", elementRef: { role: "button", name: "Next" } }),
    ];
    const plan = generateRegressionPlan(steps);
    const hasNavigate = plan.some(s => s.action === "navigate");
    assert.ok(hasNavigate, "Should insert navigate step for page transition");
  });
});
