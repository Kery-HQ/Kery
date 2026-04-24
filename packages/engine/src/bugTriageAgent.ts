import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { MemoryEntry } from "./agentMemory.js";

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
- Date/year bugs: before flagging a displayed year as "wrong" or "future", check it against the current date provided in the system prompt. A year that equals the current year is NOT a bug.

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
    let body = trimmed;
    const jsonBlock = body.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlock) body = jsonBlock[1].trim();

    const parsed = JSON.parse(body) as { decisions?: ParsedDecision[] };
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

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(messages, model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      timeoutMs: config.reviewTimeoutMs,
    });
    const durationMs = Date.now() - t0;
    const parsed = parseTriage(raw, input.bugs);
    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    const llmCall: Omit<LLMCallRecord, "seq"> = {
      stepIndex: 70_000,
      model,
      hasVision: false,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel"),
      query: `Bug triage (${input.bugs.length} candidates, ${input.openProjectBugs.length} open issues)`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      response: raw,
      agent: "bug_triage",
    };
    opts?.onLLMCall?.(llmCall);
    return { bugs: parsed.next, llmCall, skippedCount: parsed.skippedCount };
  } catch (err) {
    logger.warn({ err: String(err) }, "BugTriage: LLM call failed, returning untriaged bugs");
    return { bugs: input.bugs, llmCall: null, skippedCount: 0 };
  }
}
