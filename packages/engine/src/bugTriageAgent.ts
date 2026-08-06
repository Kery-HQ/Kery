import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS, getTriageResponseFormat } from "./llmClient.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { MemoryEntry } from "./agentMemory.js";
import { parseFirstJsonObject } from "./jsonResponse.js";

const TRIAGE_SYSTEM = `You are a senior QA triage agent.

You are given:
1) Newly detected run bugs (multiple agents may report the same underlying issue)
2) Open issues already tracked in the project (title-only list)
3) Memory context (ignore regions and known bug patterns)
4) Test intent

Your tasks:
- Remove false positives and obvious automation artifacts
- Remove duplicates across the new bug list
- Remove bugs that are already represented by an open project issue
- Remove bugs that match memory ignore guidance
- Normalize severity to low/medium/high based on actual impact

Rules:
- Be conservative with "high"; use it for data loss/corruption, auth/security blockers, checkout/payment blockers, or full flow breakage.
- If two new bugs are duplicates, keep the clearer one and set the duplicate to keep=false.
- Match open issues semantically (not exact text only).
- Keep output deterministic and concise.
- NEGATIVE CLAIMS NEED A QUOTED OBSERVATION: a bug asserting that something did NOT happen — no error appeared, a value never updated, a control did nothing, a code was not applied, a confirmation was missing — must quote the concrete text or value seen in its place. Drop it when it does not. Measured against pages verified correct beforehand, unquoted negative claims were the single largest source of false reports: promos that had in fact applied, validation errors that were in fact displayed, buttons that had in fact disabled.
- BRIEF STATES ARE NOT ABSENT: drop bugs asserting that a spinner, disabled button, "Processing"/"Saving" label or toast never appeared, unless the bug states the observation was taken WHILE the operation was still running. These states last a moment; observing afterwards misses them and proves nothing.
- THE TESTER'S OWN FAILURE IS NOT A PRODUCT BUG: drop bugs whose evidence is that the agent could not enter a value, could not find a control, or had its input land somewhere unexpected, unless the report shows the control itself is genuinely unusable — for example it is disabled, absent, or rejects a value the page states is valid.
- Date/year bugs: before flagging a displayed year as "wrong" or "future", check it against the current date provided in the system prompt. A year that equals the current year is NOT a bug.
- Placeholder text: drop bugs that describe placeholder/example text in empty inputs as "prefilled data" — that is styling, not state.
- Blocked runs: if the run was blocked before reaching a surface, drop bugs that speculate about that unreached surface; keep the blocker bug itself.
- Change-scoped runs (PR/preview tests): prefer bugs plausibly caused by the change under test. Keep clearly unrelated, likely pre-existing defects only when their impact is high, and say "likely pre-existing" in the reason so the report separates them from regressions.



Worked examples. These are real reports checked by hand against the page afterwards; the verdicts are ground truth.

DROP - "Applying the stated TEAM15 promo shows 'not recognised' and leaves the discount at $0.00."
   The page showed "Promo TEAM15 applied - 15% off". Nothing in the report quotes the discount line it claims to have read.

DROP - "Submitting with Full name empty shows no required-name error."
   The error "Full name is required." was displayed and visible. Claiming a message is absent without quoting what appeared instead is the most common false report.

DROP - "Clicking Save never puts the button into a disabled Saving state."
   The button did disable and read "Saving...". It lasts about two seconds and the observation was taken afterwards. Missing a brief state is not evidence it is absent.

DROP - "The minus control on the Washer row decrements the Hex bolt row instead."
   Only the Washer row changed. A single mis-aimed click is likelier than a control wired to the wrong row, and the report does not say the interaction was repeated.

DROP - "The route /stockroom/audit.html returns 404."
   The page is served at /audit.html; the address was assembled from a source file path. Source layout is not routing.

KEEP - "Subtotal $926.47 plus Tax $76.43 equals $1002.90, but the Total shows $1002.89."
   Quotes all three figures; the arithmetic is checkable from the report alone.

KEEP - "After saving, a reload shows Full name, company and digest all reset to defaults."
   Names the fields and the action that lost them; reproducible as written.

KEEP - "Team Annual appears as the last row of page 1 and again as the first row of page 2."
   Names the row and both locations.

The pattern: a report that QUOTES what was on screen is usually real. A report asserting something was missing, without saying what appeared instead, is usually the tester having looked in the wrong place or at the wrong moment. Judge on what the report evidences, never on whether the described behaviour sounds wrong.

Return JSON only in this exact shape:
{
  "decisions": [
    {
      "bugIndex": number,
      "keep": boolean,
      "severity": "low" | "medium" | "high",
      "reason": string
    }
  ]
}

Include one decision per input bugIndex.`;

type OpenProjectBug = {
  name?: string;
  description?: string;
};

export type BugTriageInput = {
  bugs: RunStep[];
  intent: string;
  openProjectBugs: OpenProjectBug[];
  memoryEntries: MemoryEntry[];
};

export type BugTriageResult = {
  bugs: RunStep[];
  llmCall: Omit<LLMCallRecord, "seq"> | null;
  skippedCount: number;
};

function compactOpenIssueLines(openProjectBugs: OpenProjectBug[]): string {
  if (openProjectBugs.length === 0) return "(none)";
  return openProjectBugs
    .map((b, i) => `${i + 1}. ${(b.name ?? b.description ?? "").trim() || "Untitled issue"}`)
    .join("\n");
}

function compactMemoryLines(memoryEntries: MemoryEntry[]): string {
  const relevant = memoryEntries.filter((m) => m.type === "ignore_region" || m.type === "bug_pattern");
  if (relevant.length === 0) return "(none)";
  return relevant
    .map((m, i) => `${i + 1}. [${m.type}] ${m.summary}: ${m.content}`)
    .join("\n");
}

function compactBugs(bugs: RunStep[]): string {
  return bugs
    .map((b, i) => {
      const desc = (b.reasoning ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
      const source = b.source ?? "navigator";
      const sev = b.severity ?? "medium";
      const type = b.bugType ?? "other";
      const url = b.url ?? "";
      return `${i}. [source=${source}] [type=${type}] [severity=${sev}] [url=${url}] ${desc}`;
    })
    .join("\n");
}

type ParsedDecision = {
  bugIndex: number;
  keep: boolean;
  severity: "low" | "medium" | "high";
  reason: string;
};

function parseTriage(raw: string, bugs: RunStep[]): { next: RunStep[]; skippedCount: number } {
  const fallback = { next: bugs, skippedCount: 0 };
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return fallback;
  try {
    const parsed = parseFirstJsonObject<{ decisions?: ParsedDecision[] }>(trimmed);
    if (!parsed) return fallback;
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    if (decisions.length === 0) return fallback;

    const byIndex = new Map<number, ParsedDecision>();
    for (const d of decisions) {
      if (!d || typeof d.bugIndex !== "number") continue;
      if (d.bugIndex < 0 || d.bugIndex >= bugs.length) continue;
      const sev = d.severity === "low" || d.severity === "medium" || d.severity === "high" ? d.severity : "medium";
      byIndex.set(d.bugIndex, {
        bugIndex: d.bugIndex,
        keep: Boolean(d.keep),
        severity: sev,
        reason: (d.reason ?? "").toString().slice(0, 200),
      });
    }

    if (byIndex.size === 0) return fallback;

    const next: RunStep[] = [];
    let skippedCount = 0;
    for (let i = 0; i < bugs.length; i++) {
      const bug = bugs[i]!;
      const decision = byIndex.get(i);
      if (!decision) {
        next.push(bug);
        continue;
      }
      if (!decision.keep) {
        skippedCount++;
        continue;
      }
      next.push({
        ...bug,
        severity: decision.severity,
      });
    }
    return { next, skippedCount };
  } catch (err) {
    logger.warn({ err: String(err), raw: raw?.slice(0, 200) }, "BugTriage: failed to parse response");
    return fallback;
  }
}

export async function runBugTriageAgent(
  input: BugTriageInput,
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<BugTriageResult> {
  if (!Array.isArray(input.bugs) || input.bugs.length === 0) {
    return { bugs: [], llmCall: null, skippedCount: 0 };
  }

  const config = getConfig();
  const model = config.reviewAgentModel;
  const userPrompt =
    `Test intent: ${input.intent}\n\n` +
    `Newly detected bugs (index-based):\n${compactBugs(input.bugs)}\n\n` +
    `Open issues already tracked in this project:\n${compactOpenIssueLines(input.openProjectBugs)}\n\n` +
    `Memory context (ignore_region + bug_pattern):\n${compactMemoryLines(input.memoryEntries)}`;

  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const messages = [
    { role: "system", content: `Current date/time: ${now}\n\n${TRIAGE_SYSTEM}` },
    { role: "user", content: [{ type: "text", text: userPrompt }] },
  ];

  const responseFormat = getTriageResponseFormat(model);

  try {
    const reminder = "REMINDER: Reply with one raw JSON object only. No markdown, no extra text.";
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const callMessages = attempt === 0
        ? messages
        : [
            messages[0],
            { role: "user" as const, content: [{ type: "text", text: `${userPrompt}\n\n${reminder}` }] },
          ];
      const t0 = Date.now();
      const { content: raw, usage } = await llmChat(callMessages, model, {
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        timeoutMs: config.reviewTimeoutMs,
        responseFormat,
      });
      const durationMs = Date.now() - t0;
      const attemptCost = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel");
      totalCostUsd += attemptCost;
      totalDurationMs += durationMs;

      const parsed = parseTriage(raw, input.bugs);
      const valid = parseFirstJsonObject<{ decisions?: unknown[] }>(raw) !== null;

      if (valid || attempt === 2) {
        const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(callMessages);
        const llmCall: Omit<LLMCallRecord, "seq"> = {
          stepIndex: 70_000,
          model,
          hasVision: false,
          attempt: attempt + 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          durationMs: totalDurationMs,
          costUsd: totalCostUsd,
          query: `Bug triage (${input.bugs.length} candidates, ${input.openProjectBugs.length} open issues)`,
          requestMessages,
          imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
          response: raw,
          agent: "bug_triage",
        };
        opts?.onLLMCall?.(llmCall);
        return valid
          ? { bugs: parsed.next, llmCall, skippedCount: parsed.skippedCount }
          : { bugs: input.bugs, llmCall, skippedCount: 0 };
      }
    }
    return { bugs: input.bugs, llmCall: null, skippedCount: 0 };
  } catch (err) {
    logger.warn({ err: String(err) }, "BugTriage: LLM call failed, returning untriaged bugs");
    return { bugs: input.bugs, llmCall: null, skippedCount: 0 };
  }
}
