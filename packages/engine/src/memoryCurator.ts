/**
 * LLM-based memory curation after test runs — semantic facts, dedup, correct scope.
 */
import { logger } from "./logger.js";
import { llmMemoryCurate, type MemoryCurationParsed, calcCostUsd } from "./llmClient.js";
import { getConfig } from "./config.js";
import type { RunStep, LLMCallRecord } from "./agent.js";
import type { StorageAdapter } from "./storage.js";
import type { MemoryEntry, MemoryEntryInsert } from "./agentMemory.js";
import {
  saveProjectMemoryEntries,
  boostConfidence,
} from "./agentMemory.js";

export type CurateMemoryInput = {
  intent: string;
  runStatus: "passed" | "failed";
  stepsDetail: RunStep[];
  projectId?: string;
  /** Route label for context (e.g. /inventory.html) */
  destinationRoute?: string;
  projectMemory: MemoryEntry[];
  onLLMCall?: (call: LLMCallRecord) => void;
};

export type CurateMemoryResult = {
  proposed: number;
  /** Raw parsed curation (for tests / debugging) */
  parsed: MemoryCurationParsed | null;
};

function serializeStepsForCurator(steps: RunStep[]): string {
  const lines = steps.map((s) => {
    const parts = [
      `[${s.index}]`,
      s.action,
      `status=${s.status}`,
      s.target ? `target=${JSON.stringify(s.target)}` : "",
      s.value != null && s.value !== "" ? `value=${JSON.stringify(s.value)}` : "",
      s.url ? `url=${s.url}` : "",
      s.reasoning ? `reasoning=${JSON.stringify(s.reasoning.slice(0, 200))}` : "",
      s.error ? `error=${JSON.stringify(s.error)}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  });
  return lines.join("\n");
}

function formatExisting(entries: MemoryEntry[], label: string): string {
  if (entries.length === 0) return `${label}: (none)\n`;
  const lines = entries.map(
    (e) =>
      `  id=${e.id} type=${e.type} conf=${e.confidence} summary=${JSON.stringify(e.summary)} content=${JSON.stringify(e.content)}`,
  );
  return `${label}:\n${lines.join("\n")}\n`;
}

function buildCuratorPrompt(input: CurateMemoryInput): string {
  const {
    intent,
    runStatus,
    stepsDetail,
    destinationRoute,
    projectMemory,
  } = input;

  return `You are a memory curator for a browser QA automation system. After each test run, you decide what to store so future runs are faster and smarter.

Run status: ${runStatus}
User intent: ${JSON.stringify(intent)}
${destinationRoute ? `Current page route context: ${destinationRoute}\n` : ""}
Steps (chronological):
${serializeStepsForCurator(stepsDetail)}

${formatExisting(projectMemory, "Existing memory (IDs are stable — use boost/delete/update)")}

RULES — What makes GOOD memory:
- **tips**: Stable facts: login credentials seen in fill steps, site-wide navigation (how to open cart), form field requirements, environment quirks.
- **learned_path**: ONE short semantic recipe (NOT a click trace). Example: "On inventory, add products via Add to cart under each item, then open cart via the cart badge." FORBIDDEN: repeating "click X" many times or raw element spam.
- **bug_pattern**: Repro hints for issues observed (from failed steps or bug actions).
- **avoid_region**: Only if the same control clearly failed repeatedly in this run.
- **ignore_region**: Rare; only for known flaky chrome (ads, chat widgets) if evident.

RULES — What to REJECT:
- No verbatim action traces like "click A → click A → click A".
- No duplicate entries: if an existing row already covers the fact, put its id in **boost** instead of **add**.
- **boost**: IDs from the list above that this run confirmed or reinforced (success path used them, or fact still valid).
- **delete**: IDs that are duplicate, contradictory, obsolete, or useless click-spam from older runs.
- **update**: Refine summary/content/confidence when merging meaning (use null for fields that should not change).

If nothing new is worth storing and nothing should change, return empty add/boost/delete/update arrays.

Respond ONLY with the structured JSON (already enforced by schema).`;
}

function parseCurationJson(raw: string): MemoryCurationParsed | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as MemoryCurationParsed;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as MemoryCurationParsed;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function knownIds(projectMemory: MemoryEntry[]): Set<string> {
  const s = new Set<string>();
  for (const e of projectMemory) s.add(e.id);
  return s;
}

/**
 * Runs the memory curator LLM and applies add / boost / delete / update to storage.
 */
export async function curateMemoryAfterRun(
  storage: StorageAdapter,
  input: CurateMemoryInput,
): Promise<CurateMemoryResult> {
  if (!input.projectId) {
    return { proposed: 0, parsed: null };
  }

  const prompt = buildCuratorPrompt(input);
  const config = getConfig();
  const model = config.auxiliaryModel;
  const t0 = Date.now();

  let parsed: MemoryCurationParsed | null = null;
  try {
    const { content, usage } = await llmMemoryCurate(prompt);
    const durationMs = Date.now() - t0;
    parsed = parseCurationJson(content);

    const curatorCall: LLMCallRecord = {
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
      agent: "memory_curator",
    };
    input.onLLMCall?.(curatorCall);
  } catch (err) {
    logger.warn({ err: String(err) }, "Memory curator LLM failed — skipping memory updates");
    return { proposed: 0, parsed: null };
  }

  if (!parsed) {
    logger.warn("Memory curator returned unparsable JSON — skipping memory updates");
    return { proposed: 0, parsed: null };
  }

  const validIds = knownIds(input.projectMemory);

  const toDelete = parsed.delete.filter((id) => UUID_RE.test(id) && validIds.has(id));
  const toBoost = parsed.boost.filter((id) => UUID_RE.test(id) && validIds.has(id));

  if (toDelete.length > 0) {
    await storage.deleteMemoryEntries(toDelete);
  }

  for (const u of parsed.update) {
    if (!UUID_RE.test(u.id) || !validIds.has(u.id)) continue;
    const data: { summary?: string; content?: string; confidence?: number } = {};
    if (u.summary !== null) data.summary = u.summary;
    if (u.content !== null) data.content = u.content;
    if (u.confidence !== null) data.confidence = u.confidence;
    if (Object.keys(data).length > 0) {
      await storage.updateMemoryEntry(u.id, data);
    }
  }

  if (toBoost.length > 0) {
    await boostConfidence(storage, toBoost, 5);
  }

  const adds: MemoryEntryInsert[] = [];

  for (const a of parsed.add) {
    if (!a.summary?.trim() || !a.content?.trim()) continue;
    const conf = Math.max(0, Math.min(100, a.confidence ?? 65));
    adds.push({
      type: a.type,
      summary: a.summary.slice(0, 500),
      content: a.content.slice(0, 4000),
      source: "agent",
      confidence: conf,
      region:
        a.regionDescription && a.regionDescription.trim()
          ? { description: a.regionDescription.trim() }
          : undefined,
    });
  }

  if (adds.length > 0) {
    await saveProjectMemoryEntries(storage, input.projectId, adds);
  }

  /** Count of curator actions relevant to run summary (new rows + confirmations). */
  const proposed = adds.length + toBoost.length;

  logger.info(
    {
      add: adds.length,
      boost: toBoost.length,
      delete: toDelete.length,
      update: parsed.update.length,
    },
    "Memory curator applied",
  );

  return { proposed, parsed };
}
