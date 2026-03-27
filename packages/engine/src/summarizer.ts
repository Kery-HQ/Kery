import { llmSummarize, calcCostUsd } from "./llmClient.js";
import { getConfig } from "./config.js";
import type { RunStep, LLMCallRecord } from "./agent.js";
import type { MemoryEntry } from "./agentMemory.js";

export type SummarizeResult = {
  summary: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
  model?: string;
  durationMs?: number;
};

export type SummarizeInput = {
  intent: string;
  status: "passed" | "failed" | "partial";
  baseUrl: string;
  stepsDetail: RunStep[];
  bugsFound: RunStep[];
  llmCalls: LLMCallRecord[];
  memoryLoaded: MemoryEntry[];
  memoryProposed: number;
  videoUrl?: string;
  durationMs?: number;
};

export async function summarizeRun(input: SummarizeInput): Promise<SummarizeResult> {
  const prompt = buildPrompt(input);

  try {
    const config = getConfig();
    const model = config.summaryModel;
    const t0 = Date.now();
    const { content, usage } = await llmSummarize(prompt);
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens);
    return { summary: content, usage, costUsd, model, durationMs };
  } catch {
    return { summary: buildFallbackSummary(input) };
  }
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(input: SummarizeInput): string {
  const { intent, status, baseUrl, stepsDetail, bugsFound, llmCalls, memoryLoaded, memoryProposed, videoUrl, durationMs } = input;

  // Compute stats
  const okSteps = stepsDetail.filter(s => s.status === "ok" && !["done", "auth", "bug"].includes(s.action));
  const failedSteps = stepsDetail.filter(s => s.status === "failed");
  const skippedSteps = stepsDetail.filter(s => s.status === "skipped");
  const authSteps = stepsDetail.filter(s => s.action === "auth");
  const uniqueUrls = [...new Set(stepsDetail.map(s => s.url).filter(Boolean))];

  const navigatorBugs = bugsFound.filter(b => b.source === "navigator");
  const reviewBugs = bugsFound.filter(b => b.source === "review");

  const navigatorCalls = llmCalls.filter(c => c.agent === "navigator");
  const reviewCalls = llmCalls.filter(c => c.agent === "review");
  const pathgenCalls = llmCalls.filter(c => c.agent === "pathgen");

  const totalCost = llmCalls.reduce((s, c) => s + c.costUsd, 0);
  const totalTokens = llmCalls.reduce((s, c) => s + c.totalTokens, 0);

  // Format step trace
  const stepTrace = stepsDetail.map(s => {
    const statusIcon = s.status === "ok" ? "OK" : s.status === "failed" ? "FAIL" : "SKIP";
    const parts = [`[${s.index}] ${statusIcon} ${s.action}`];
    if (s.target) parts.push(`target="${s.target}"`);
    if (s.value) parts.push(`value="${s.value}"`);
    if (s.url) parts.push(`url=${s.url}`);
    if (s.reasoning) parts.push(`-- ${s.reasoning}`);
    if (s.error) parts.push(`ERROR: ${s.error}`);
    return parts.join(" ");
  }).join("\n");

  // Format bugs
  const bugDetails = bugsFound.map(b => {
    const parts = [`- [${b.severity ?? "medium"}] ${b.reasoning}`];
    if (b.url) parts.push(`  at ${b.url}`);
    if (b.source) parts.push(`  (found by: ${b.source})`);
    if (b.bugType) parts.push(`  type: ${b.bugType}`);
    return parts.join("\n");
  }).join("\n");

  // Format transient failures (failed steps that were recovered from)
  const transientFailures = failedSteps.filter(s => {
    const laterOk = stepsDetail.find(later => later.index > s.index && later.status === "ok" && later.action !== "auth");
    return !!laterOk;
  });

  const transientTrace = transientFailures.length > 0
    ? transientFailures.map(s => `- Step ${s.index}: ${s.action} ${s.target ?? ""} -- ${s.error ?? s.reasoning ?? "unknown"}`).join("\n")
    : "None";

  // Format memory
  const memoryInfo = memoryLoaded.length > 0
    ? memoryLoaded.map(m => `- [${m.type}/${m.scope}] ${m.summary}`).join("\n")
    : "No memory loaded";

  // LLM cost breakdown
  const costBreakdown = [
    navigatorCalls.length > 0 ? `Navigator: ${navigatorCalls.length} calls, $${navigatorCalls.reduce((s, c) => s + c.costUsd, 0).toFixed(4)}` : null,
    reviewCalls.length > 0 ? `Review: ${reviewCalls.length} calls, $${reviewCalls.reduce((s, c) => s + c.costUsd, 0).toFixed(4)}` : null,
    pathgenCalls.length > 0 ? `Path Gen: ${pathgenCalls.length} calls, $${pathgenCalls.reduce((s, c) => s + c.costUsd, 0).toFixed(4)}` : null,
  ].filter(Boolean).join("\n");

  return `You are a QA report generator. Analyze the following E2E browser test run data and produce a comprehensive markdown report.

You MUST follow the exact template below. Fill in every section. Be specific and analytical — reference actual step numbers, URLs, actions, and error messages. Do not be vague or generic.

=== RUN DATA ===

Intent: ${intent}
Final Status: ${status}
Base URL: ${baseUrl}
Duration: ${durationMs ? `${(durationMs / 1000).toFixed(1)}s` : "unknown"}
Video: ${videoUrl || "not recorded"}

--- STATISTICS ---
Total steps: ${stepsDetail.length} (${okSteps.length} passed, ${failedSteps.length} failed, ${skippedSteps.length} skipped)
Authentication steps: ${authSteps.length}
Unique URLs visited: ${uniqueUrls.length}
Bugs found: ${bugsFound.length} (${navigatorBugs.length} by navigator, ${reviewBugs.length} by review agent)
LLM calls: ${llmCalls.length} (${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(4)})
Memory entries loaded: ${memoryLoaded.length}
Memory entries proposed: ${memoryProposed}

--- FULL STEP TRACE ---
${stepTrace || "No steps recorded"}

--- BUGS FOUND ---
${bugDetails || "No bugs found"}

--- TRANSIENT FAILURES (recovered from) ---
${transientTrace}

--- MEMORY CONTEXT ---
${memoryInfo}

--- LLM COST BREAKDOWN ---
${costBreakdown || "No LLM calls"}

--- URLS VISITED ---
${uniqueUrls.join("\n") || "None"}

=== END RUN DATA ===

Now produce the report using this EXACT markdown template. Every section is mandatory — write "None" or "N/A" if a section has no relevant data, but never omit a section.

\`\`\`template
## Run Report

**Intent**: (restate the test intent)
**Result**: (PASSED / FAILED / PARTIAL with one-sentence explanation of why)

### Executive Summary

(2-4 sentences: what was tested, what happened at a high level, and the final verdict. Be direct.)

### Navigation Trace

(Describe the path the agent took through the application. Group by page/URL where possible. Mention the total number of actions and which were most significant. Reference step numbers.)

### Authentication

(How did auth work? Was it needed? Did it succeed on first try? If skipped, say so.)

### Test Execution Analysis

#### Successful Actions
(List the key actions that completed successfully. Focus on the most meaningful ones, not every click. Reference step numbers.)

#### Failed Actions
(List every action that failed and why. Include the error message. Reference step numbers.)

#### Transient Failures
(Actions that failed but the agent recovered and continued. Explain what happened and how recovery occurred. If none, say "No transient failures detected.")

### Bugs Found

(For each bug: severity, type, description, URL where it occurred, which agent found it. If no bugs, say "No bugs detected.")

### Review Agent Analysis

(What did the review agent inspect? How many screenshots were analyzed? What did it find vs. miss? If review agent was not active, say so.)

### Memory & Context

(What memory was loaded? How many entries? Was it useful for the run? How many new memories were proposed from this run?)

### Cost & Performance

| Metric | Value |
|--------|-------|
| Duration | (value) |
| Total LLM Calls | (value) |
| Total Tokens | (value) |
| Total Cost | (value) |
| Navigator Calls/Cost | (value) |
| Review Calls/Cost | (value) |
| Path Gen Calls/Cost | (value) |

### Recommendations

For each recommendation, categorize it with one of these types:
- **[FIX]** — A bug or issue that needs to be fixed in the application
- **[FLAKY]** — A flaky/unreliable test step that needs stabilization (better selectors, explicit waits)
- **[COVERAGE]** — A gap in test coverage that should be addressed
- **[PERF]** — A performance concern observed during the run
- **[CONFIG]** — A configuration or environment issue

Format each recommendation as:
1. **[TYPE]** Short title — Detailed actionable description referencing specific steps, URLs, or elements.

(1-3 concrete, actionable suggestions based on what happened in this run.)
\`\`\`

IMPORTANT:
- Output ONLY the markdown content (no wrapping code fences around the whole thing)
- Reference specific step numbers, URLs, error messages — be precise
- For failed/partial runs, the analysis of what went wrong is the most important part
- For passed runs, focus on coverage and what was verified
- Keep each section concise but complete — aim for the report to be 300-600 words total`;
}

// ─── Fallback (no LLM) ─────────────────────────────────────────────────────

function buildFallbackSummary(input: SummarizeInput): string {
  const { intent, status, stepsDetail, bugsFound } = input;
  const okCount = stepsDetail.filter(s => s.status === "ok").length;
  const failCount = stepsDetail.filter(s => s.status === "failed").length;

  return `## Run Report

**Intent**: ${intent}
**Result**: ${status.toUpperCase()}

### Executive Summary

The test run completed with status **${status}**. ${okCount} steps passed and ${failCount} failed out of ${stepsDetail.length} total steps. ${bugsFound.length} bug(s) were detected.

*Detailed analysis unavailable — summary model returned an error.*`;
}
