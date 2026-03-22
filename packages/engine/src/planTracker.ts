/**
 * Plan Tracker: tracks plan progress through the agent loop.
 */
import type { Page } from "playwright";
import { evaluateCondition, type CompletionCondition } from "./regressionEngine.js";

export type TrackedStep = {
  description: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  doneWhen?: CompletionCondition;
  attempts: number;
};

export type MicroGoal = {
  name: string;
  steps: TrackedStep[];
  doneWhen?: CompletionCondition;
};

const MAX_ATTEMPTS_PER_STEP = 3;

export class PlanTracker {
  steps: TrackedStep[];
  currentIndex: number;
  private previousUrl = "";

  constructor(steps: TrackedStep[]) {
    this.steps = steps;
    this.currentIndex = 0;
    if (steps.length > 0) {
      steps[0].status = "in_progress";
    }
  }

  static fromDescriptions(descriptions: string[], conditions?: CompletionCondition[]): PlanTracker {
    const steps: TrackedStep[] = descriptions.map((desc, i) => ({
      description: desc,
      status: "pending" as const,
      doneWhen: conditions?.[i],
      attempts: 0,
    }));
    return new PlanTracker(steps);
  }

  static fromMicroGoals(goals: MicroGoal[]): PlanTracker {
    const allSteps: TrackedStep[] = [];
    for (const goal of goals) {
      for (const step of goal.steps) {
        allSteps.push(step);
      }
    }
    return new PlanTracker(allSteps);
  }

  formatForLLM(): string {
    if (this.steps.length === 0) return "";

    const current = this.currentIndex + 1;
    const total = this.steps.length;
    const lines: string[] = [];

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      let marker: string;
      if (step.status === "done") marker = "[done]";
      else if (step.status === "failed") marker = "[FAIL]";
      else if (step.status === "skipped") marker = "[skip]";
      else if (i === this.currentIndex) marker = "[NOW] ";
      else marker = "[ ]   ";
      lines.push(`  ${marker} ${i + 1}. ${step.description}`);
    }

    const currentStep = this.steps[this.currentIndex];
    const objective = currentStep ? `\nCURRENT OBJECTIVE: ${currentStep.description}` : "";

    return `PLAN PROGRESS (step ${current} of ${total}):\n${lines.join("\n")}${objective}`;
  }

  async evaluate(page: Page): Promise<void> {
    const current = this.steps[this.currentIndex];
    if (!current || current.status !== "in_progress") return;

    current.attempts++;

    if (current.doneWhen) {
      if (current.doneWhen.type === "url_changed") {
        const currentUrl = page.url();
        if (currentUrl !== this.previousUrl && this.previousUrl) {
          current.status = "done";
          this.advance();
          this.previousUrl = currentUrl;
          return;
        }
        this.previousUrl = currentUrl;
      } else {
        const met = await evaluateCondition(page, current.doneWhen);
        if (met) {
          current.status = "done";
          this.advance();
          return;
        }
      }
    }

    this.previousUrl = page.url();
  }

  markCurrentDone(): void {
    const current = this.steps[this.currentIndex];
    if (current) {
      current.status = "done";
      this.advance();
    }
  }

  markCurrentFailed(): void {
    const current = this.steps[this.currentIndex];
    if (current) {
      current.status = "failed";
      this.advance();
    }
  }

  advance(): void {
    if (this.currentIndex >= this.steps.length - 1) return;
    this.currentIndex++;
    this.steps[this.currentIndex].status = "in_progress";
  }

  isComplete(): boolean {
    return this.steps.every(s => s.status === "done" || s.status === "skipped" || s.status === "failed");
  }

  isStuck(): boolean {
    const current = this.steps[this.currentIndex];
    return current ? current.attempts >= MAX_ATTEMPTS_PER_STEP : false;
  }

  getStuckHint(): string | null {
    if (!this.isStuck()) return null;
    return `STUCK: Step "${this.steps[this.currentIndex].description}" attempted ${MAX_ATTEMPTS_PER_STEP} times. Try an alternative approach or skip to the next step by calling a different action.`;
  }

  getCompletionStats(): { total: number; done: number; failed: number; skipped: number } {
    return {
      total: this.steps.length,
      done: this.steps.filter(s => s.status === "done").length,
      failed: this.steps.filter(s => s.status === "failed").length,
      skipped: this.steps.filter(s => s.status === "skipped").length,
    };
  }
}
