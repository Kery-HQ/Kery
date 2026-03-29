import { loadProjectMemory, loadPageMemory, formatMemoryForPrompt } from "./agentMemory.js";
import { llmPathPlan } from "./llmClient.js";
import type { LLMUsage } from "./llmClient.js";
import { logger } from "./logger.js";
import type { TestPlan, PathStep, AppTreeDestination } from "./types.js";
import type { MemoryEntry } from "./agentMemory.js";
import type { StorageAdapter } from "./storage.js";

const MAX_PAST_RUNS = 10;
const MAX_OPEN_BUGS = 20;

export type PathGeneratorInput = {
  projectId: string;
  destinationId: string;
  destination: AppTreeDestination;
  intent?: string;
};

export type GenerateTestPlanResult = {
  plan: TestPlan;
  usage?: LLMUsage;
  /** Full user prompt sent to the path planner. */
  prompt?: string;
  /** Raw model output string. */
  rawResponse?: string;
};

/**
 * Loads memory, past run results, and open bugs for the destination,
 * then calls the LLM to generate a structured test plan.
 */
export async function generateTestPlan(storage: StorageAdapter, input: PathGeneratorInput): Promise<GenerateTestPlanResult> {
  const { projectId, destinationId, destination, intent } = input;

  const [projectMemory, pageMemory] = await Promise.all([
    loadProjectMemory(storage, projectId),
    loadPageMemory(storage, destinationId),
  ]);
  const memoryEntries: MemoryEntry[] = [...pageMemory, ...projectMemory];
  const memorySection = formatMemoryForPrompt(memoryEntries);

  const pastRunsSection = await getPastRunsSection(storage, destinationId);
  const bugsSection = await getOpenBugsSection(storage, projectId);
  const destSection = formatDestinationSection(destination);

  const intentLine = intent ? `\nUser intent for this run: "${intent}"` : "";

  const prompt = `You are a test plan generator for a browser QA agent. Given the following context, produce a structured test plan for the page.

${destSection}
${memorySection ? `\n${memorySection}` : ""}
${pastRunsSection}
${bugsSection}
${intentLine}

Generate a JSON object with exactly these keys:
- happyPaths: array of paths (each path is an array of steps). Each step: { action, target, reasoning, optional value, optional expectation }. Actions: navigate, click, fill, assert, wait, hover, scroll, pressKey, selectOption, back.
- sadPaths: paths that test validation (empty submit, invalid input, etc.)
- edgeCases: paths for double-submit, back button, refresh, etc.
- interactionFlows: paths for modals, drawers, tabs (open, interact, close)
- regressionChecks: paths to re-verify known bugs from the bugs section above
- authFlows: paths for login/logout, session expiry, protected page access
- dataIntegrity: paths that verify data is correctly saved, updated, and displayed (create → verify → edit → verify)
- boundaryValues: paths for min/max input lengths, special characters, unicode, empty strings
- crossPageFlows: paths that span multiple pages (e.g., create on page A, verify on page B)

PRIORITIZATION: Generate happy paths first, then sad paths, then edge cases, then the rest.

Use human-readable targets (e.g. "Submit button", "Email field"). The Navigator will resolve them to coordinates. Include brief reasoning for each step. For fill steps, suggest concrete test values where relevant (e.g. invalid email "not-an-email").
Keep each reasoning to one short sentence. Use as many steps per path as needed to complete the scenario.`;

  const { content, usage } = await llmPathPlan(prompt);
  return { plan: parseTestPlan(content), usage, prompt, rawResponse: content };
}

async function getPastRunsSection(storage: StorageAdapter, destinationId: string): Promise<string> {
  const runs = await storage.getPastRunsForDestination(destinationId, MAX_PAST_RUNS);
  if (!runs?.length) return "";

  const lines = runs.map((r) => {
    const status = r.status ?? "?";
    const stepCount = Array.isArray(r.steps_json) ? r.steps_json.length : 0;
    return `  - Run ${(r.id as string).slice(0, 8)}: ${status}, ${stepCount} steps${r.summary ? ` \u2014 ${String(r.summary).slice(0, 60)}` : ""}`;
  });
  return `Past runs for this destination:\n${lines.join("\n")}`;
}

async function getOpenBugsSection(storage: StorageAdapter, projectId: string): Promise<string> {
  const bugs = await storage.getOpenBugs(projectId, MAX_OPEN_BUGS);
  if (!bugs?.length) return "";

  const lines = bugs.map((b: any) => `  - [${b.category}] ${b.name ?? b.description?.slice(0, 60)} (${b.severity}) \u2014 ${b.url ?? "\u2014"}`);
  return `Open bugs to regression-test or avoid:\n${lines.join("\n")}`;
}

function formatDestinationSection(dest: AppTreeDestination): string {
  const forms = (dest.forms_json ?? []) as Array<{ id?: string; fields?: Array<{ name: string; type: string; label?: string; required?: boolean }>; submitText?: string }>;
  const buttons = (dest.buttons_json ?? []) as Array<{ text: string }>;
  const interactions = (dest.interactions_json ?? []) as Array<{ trigger: string; revealed: string; heading?: string }>;

  const formLines = forms.map((f) => {
    const fields = (f.fields ?? []).map((fd) => `${fd.label || fd.name} (${fd.type}${fd.required ? ", required" : ""})`).join(", ");
    return `  - Form: ${fields}; submit: "${f.submitText ?? "Submit"}"`;
  });
  const buttonLines = buttons.length ? `  Buttons: ${buttons.map((b) => b.text).join(", ")}` : "";
  const interactionLines = interactions.length
    ? `  Interactions: ${interactions.map((i) => `${i.trigger} \u2192 ${i.revealed} (${i.heading ?? ""})`).join("; ")}`
    : "";

  return `Destination: ${dest.normalized_route}
Title: ${dest.title}
Forms:
${formLines.join("\n")}
${buttonLines}
${interactionLines}`;
}

function parseTestPlan(raw: string): TestPlan {
  const empty: TestPlan = {
    happyPaths: [],
    sadPaths: [],
    edgeCases: [],
    interactionFlows: [],
    regressionChecks: [],
    authFlows: [],
    dataIntegrity: [],
    boundaryValues: [],
    crossPageFlows: [],
  };
  let toParse = raw?.trim() ?? "";
  if (!toParse) return empty;
  try {
    if (!toParse.endsWith("}") && toParse.includes('"happyPaths"')) {
      const lastPathStepEnd = toParse.lastIndexOf("},\n");
      if (lastPathStepEnd > 0) {
        toParse = toParse.slice(0, lastPathStepEnd + 1) + "]]},\n  \"sadPaths\": [],\n  \"edgeCases\": [],\n  \"interactionFlows\": [],\n  \"regressionChecks\": []\n}";
      }
    }
    const parsed = JSON.parse(toParse) as Record<string, unknown>;
    const toPathSteps = (arr: unknown): PathStep[] => {
      if (!Array.isArray(arr)) return [];
      const steps: PathStep[] = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const action = String(o.action ?? "click") as PathStep["action"];
        const target = String(o.target ?? "");
        const reasoning = String(o.reasoning ?? "");
        if (!target && !reasoning) continue;
        const step: PathStep = { action, target, reasoning };
        if (o.value != null) step.value = String(o.value);
        if (o.expectation != null) step.expectation = String(o.expectation);
        steps.push(step);
      }
      return steps;
    };
    const toPaths = (arr: unknown): PathStep[][] => {
      if (!Array.isArray(arr)) return [];
      return arr.map((path) => toPathSteps(path));
    };
    return {
      happyPaths: toPaths(parsed.happyPaths),
      sadPaths: toPaths(parsed.sadPaths),
      edgeCases: toPaths(parsed.edgeCases),
      interactionFlows: toPaths(parsed.interactionFlows),
      regressionChecks: toPaths(parsed.regressionChecks),
      authFlows: toPaths(parsed.authFlows),
      dataIntegrity: toPaths(parsed.dataIntegrity),
      boundaryValues: toPaths(parsed.boundaryValues),
      crossPageFlows: toPaths(parsed.crossPageFlows),
    };
  } catch (err) {
    logger.warn({ err: String(err), raw: raw?.slice(0, 300) }, "PathGenerator: failed to parse TestPlan");
    return empty;
  }
}

/**
 * Formats a TestPlan into a string the Navigator can use as context.
 */
export function formatTestPlanForNavigator(plan: TestPlan): string {
  const sections: string[] = [];

  const addSection = (title: string, paths: PathStep[][]) => {
    if (paths.length === 0) return;
    const lines = paths.map((path, i) => {
      const stepStrs = path.map((s, j) => `  ${j + 1}. ${s.action} "${s.target}"${s.value ? ` = "${s.value}"` : ""}${s.expectation ? ` \u2192 expect: ${s.expectation}` : ""} (${s.reasoning})`);
      return `${title} path ${i + 1}:\n${stepStrs.join("\n")}`;
    });
    sections.push(lines.join("\n\n"));
  };

  // Prioritized order: happy paths first, then sad, then edge cases, then rest
  addSection("Happy", plan.happyPaths);
  addSection("Sad", plan.sadPaths);
  addSection("Edge case", plan.edgeCases);
  addSection("Interaction", plan.interactionFlows);
  addSection("Regression", plan.regressionChecks);
  addSection("Auth flow", plan.authFlows);
  addSection("Data integrity", plan.dataIntegrity);
  addSection("Boundary value", plan.boundaryValues);
  addSection("Cross-page", plan.crossPageFlows);

  if (sections.length === 0) return "";
  return `Test plan (execute in order, follow each path as listed):\n\n${sections.join("\n\n")}`;
}
