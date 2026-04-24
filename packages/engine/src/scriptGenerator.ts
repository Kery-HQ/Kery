/**
 * LLM-based regression script generator.
 *
 * After a successful run, generates a deterministic RegressionStep[] from the
 * recorded RunStep trace using the auxiliary model. Falls back to the
 * rule-based generateRegressionPlan() if the LLM call fails.
 */
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import { getConfig } from "./config.js";
import { generateRegressionPlan, type RegressionStep } from "./regressionEngine.js";
import type { RunStep, LLMCallRecord } from "./agent.js";

// ─── JSON schema for the LLM output ───────────────────────────────────────────

const REGRESSION_STEP_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["click", "fill", "pressKey", "selectOption", "navigate", "assert", "scroll", "back", "wait"],
    },
    role:    { type: ["string", "null"] },
    name:    { type: ["string", "null"] },
    value:   { type: ["string", "null"] },
    url:     { type: ["string", "null"] },
    purpose: { type: ["string", "null"] },
    captureUrlAs: { type: ["string", "null"] },
    doneWhenType: {
      type: ["string", "null"],
      enum: ["url_contains", "url_changed", "element_visible", "element_gone", "text_visible", "value_changed", null],
    },
    doneWhenValue: { type: ["string", "null"] },
    doneWhenRole:  { type: ["string", "null"] },
    doneWhenName:  { type: ["string", "null"] },
    doneWhenText:  { type: ["string", "null"] },
  },
  required: [
    "action", "role", "name", "value", "url", "purpose",
    "captureUrlAs", "doneWhenType", "doneWhenValue",
    "doneWhenRole", "doneWhenName", "doneWhenText",
  ],
  additionalProperties: false,
};

const SCRIPT_GENERATION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "regression_script",
    strict: true,
    schema: {
      type: "object",
      properties: {
        steps: { type: "array", items: REGRESSION_STEP_SCHEMA },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
};

// ─── Prompt ────────────────────────────────────────────────────────────────────

function serializeRunSteps(steps: RunStep[]): string {
  return steps
    .filter(s => s.status === "ok")
    .map(s => {
      const parts = [
        `[${s.index}]`,
        s.action,
        s.elementRef ? `${s.elementRef.role}:"${s.elementRef.name}"` : s.target ? `"${s.target}"` : "",
        s.value != null && s.value !== "" ? `= ${JSON.stringify(s.value)}` : "",
        s.url ? `@ ${s.url}` : "",
        s.reasoning ? `// ${s.reasoning.slice(0, 150)}` : "",
      ].filter(Boolean);
      return parts.join(" ");
    })
    .join("\n");
}

function buildPrompt(intent: string, steps: RunStep[]): string {
  return `You are generating a deterministic regression script for a browser QA system.

The script will be replayed by Playwright on future runs — no LLM involved during replay. Each step must be reliable and self-contained.

Test intent: ${JSON.stringify(intent)}

Recorded run steps (successful):
${serializeRunSteps(steps)}

Generate a clean regression script as a JSON array of steps. Each step has:
- action: the Playwright action to perform
- role/name: ARIA role and accessible name to locate the element (prefer these over coordinates)
- value: the value to fill, key to press, or assertion text
- url: the page URL where this action happens
- purpose: one-line human-readable description
- captureUrlAs: if this step causes a navigation to a URL that contains dynamic segments (UUIDs, numeric IDs), set this to a short variable name (e.g. "issueUrl") so subsequent steps can reference it
- doneWhenType/doneWhenValue/doneWhenRole/doneWhenName/doneWhenText: completion condition for the step

For doneWhen, use:
- url_contains + doneWhenValue: when the step triggers a page navigation
- element_visible + doneWhenRole + doneWhenName: when a new element should appear
- text_visible + doneWhenText: when specific text should become visible
- null: when no wait condition is needed

For navigate steps that go to a URL captured via captureUrlAs, use the variable in the url field as \`{{varName/segmentIndex}}\` where segmentIndex is the 0-based index of the dynamic segment in the path (e.g. \`http://host/team/issues/{{issueUrl/4}}\`).

Important rules:
- Preserve every distinct click in the recorded steps, even if two clicks look related (e.g. "Delete issue" followed by "Confirm" or "OK" in a dialog). Confirmation dialogs block the page — skipping the confirm click will leave the dialog open and break replay.
- combobox elements often have a name that is the concatenation of all their option labels (e.g. "BacklogTodoIn ProgressDone"). Truncate the name to just the currently selected value or the first recognisable label so Playwright can match it.

Output ONLY the JSON. No explanation.`;
}

// ─── Response parsing ──────────────────────────────────────────────────────────

type RawStep = {
  action: string;
  role: string | null;
  name: string | null;
  value: string | null;
  url: string | null;
  purpose: string | null;
  captureUrlAs: string | null;
  doneWhenType: string | null;
  doneWhenValue: string | null;
  doneWhenRole: string | null;
  doneWhenName: string | null;
  doneWhenText: string | null;
};

function parseResponse(raw: string): RegressionStep[] | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const rawSteps: RawStep[] = parsed?.steps ?? [];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const steps: RegressionStep[] = rawSteps.map((s): RegressionStep => {
    const step: RegressionStep = {
      action: s.action as RegressionStep["action"],
      role: s.role ?? undefined,
      name: s.name ?? undefined,
      value: s.value ?? undefined,
      url: s.url ?? undefined,
      purpose: s.purpose ?? undefined,
      captureUrlAs: s.captureUrlAs ?? undefined,
    };

    if (s.doneWhenType) {
      switch (s.doneWhenType) {
        case "url_contains":
          if (s.doneWhenValue) step.doneWhen = { type: "url_contains", value: s.doneWhenValue };
          break;
        case "url_changed":
          step.doneWhen = { type: "url_changed" };
          break;
        case "element_visible":
          if (s.doneWhenRole && s.doneWhenName) step.doneWhen = { type: "element_visible", role: s.doneWhenRole, name: s.doneWhenName };
          break;
        case "element_gone":
          if (s.doneWhenRole && s.doneWhenName) step.doneWhen = { type: "element_gone", role: s.doneWhenRole, name: s.doneWhenName };
          break;
        case "text_visible":
          if (s.doneWhenText) step.doneWhen = { type: "text_visible", text: s.doneWhenText };
          break;
        case "value_changed":
          if (s.doneWhenRole && s.doneWhenName) step.doneWhen = { type: "value_changed", role: s.doneWhenRole, name: s.doneWhenName };
          break;
      }
    }

    return step;
  });

  const filtered = steps.filter(s => s.action);

  // Remove consecutive duplicate navigate steps (same URL in a row)
  return filtered.filter((step, i) => {
    if (step.action !== "navigate" || i === 0) return true;
    const prev = filtered[i - 1];
    return !(prev.action === "navigate" && prev.value === step.value && prev.url === step.url);
  });
}

// ─── Main export ───────────────────────────────────────────────────────────────

export type GenerateScriptResult = {
  plan: RegressionStep[];
  source: "llm" | "fallback";
};

export async function generateScriptWithLLM(
  intent: string,
  stepsDetail: RunStep[],
  onLLMCall?: (call: LLMCallRecord) => void,
): Promise<GenerateScriptResult> {
  const config = getConfig();
  const model = config.auxiliaryModel;
  const prompt = buildPrompt(intent, stepsDetail);
  const t0 = Date.now();

  try {
    const { content, usage } = await llmChat(
      [{ role: "user", content: prompt }],
      model,
      { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.1, responseFormat: SCRIPT_GENERATION_SCHEMA },
    );

    const durationMs = Date.now() - t0;
    const call: LLMCallRecord = {
      seq: 0,
      stepIndex: 0,
      model,
      hasVision: false,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens, "auxiliaryModel"),
      query: prompt.slice(0, 8000),
      requestMessages: [{ role: "user", content: prompt }],
      response: content ?? "",
      agent: "script_generator" as any,
    };
    onLLMCall?.(call);

    const plan = parseResponse(content);
    if (plan && plan.length > 0) {
      logger.info({ steps: plan.length, model }, "Script generator: LLM script generated");
      return { plan, source: "llm" };
    }

    logger.warn("Script generator: LLM returned empty/unparsable plan — falling back");
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Script generator: LLM call failed — falling back");
  }

  const plan = generateRegressionPlan(stepsDetail);
  return { plan, source: "fallback" };
}
