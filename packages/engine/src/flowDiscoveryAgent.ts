import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import { parseFirstJsonObject } from "./jsonResponse.js";

export type DiscoveredFlow = {
  name: string;
  intent: string;
};

export type FlowDiscoveryResult = {
  flows: DiscoveredFlow[];
  llmCall: Omit<LLMCallRecord, "seq"> | null;
};

const DISCOVERY_SYSTEM = `You are an expert at identifying high-value functional test flows in web applications.

Given a map of pages and sections discovered during an exploratory navigation run, identify the 5-10 most important user flows worth testing.

Rules:
- Focus on complete user tasks, not individual navigation steps
- Prioritize: authentication, core CRUD operations, checkout/payment, key user journeys, critical paths
- Write each intent as step-by-step instructions the test agent should follow, starting from the app's base URL
- Keep names concise (2-5 words, title case)
- Do NOT include pure navigation tests (e.g. "navigate to settings page")
- Each flow should test one meaningful user goal end-to-end

Return JSON only, no markdown:
[{"name": "Short Name", "intent": "Start at [URL], then... complete step-by-step instructions"}]`;

function compactStepsForDiscovery(stepsDetail: RunStep[]): string {
  const pageMap = new Map<string, { url: string; observations: string[]; clicked: string[] }>();

  for (const step of stepsDetail) {
    if (!step.url) continue;
    let key: string;
    try {
      const u = new URL(step.url);
      key = u.origin + u.pathname;
    } catch {
      key = step.url;
    }

    if (!pageMap.has(key)) {
      pageMap.set(key, { url: step.url, observations: [], clicked: [] });
    }
    const entry = pageMap.get(key)!;

    if (step.action === "observe" && step.observation) {
      const obs = step.observation.trim().slice(0, 200);
      if (obs && !entry.observations.includes(obs)) entry.observations.push(obs);
    }
    if ((step.action === "navigate" || step.action === "plan") && step.reasoning) {
      const r = step.reasoning.trim().slice(0, 150);
      if (r && !entry.observations.includes(r)) entry.observations.push(r);
    }
    if (step.action === "click" && step.target) {
      const t = step.target.trim().slice(0, 80);
      if (t && !entry.clicked.includes(t)) entry.clicked.push(t);
    }
  }

  const lines: string[] = [];
  for (const [, entry] of pageMap) {
    const obs = entry.observations.slice(0, 2).join(" | ");
    const clicks = entry.clicked.slice(0, 4).join(", ");
    let line = `URL: ${entry.url}`;
    if (obs) line += `\n  What's here: ${obs}`;
    if (clicks) line += `\n  Navigation items found: ${clicks}`;
    lines.push(line);
    if (lines.join("\n").length > 4000) break;
  }

  return lines.length > 0 ? lines.join("\n\n") : "(no pages discovered)";
}

const DEDUP_SYSTEM = `You are a deduplication assistant for automated test flows.
Given a list of existing flows and a list of newly discovered flows, identify which newly discovered flows are genuinely NEW — not already covered by any existing flow.

Two flows are duplicates if they test substantially the same user journey, even if named or worded differently.

Return a JSON array of 1-based indices of the newly discovered flows that are genuinely new.
Example: [1, 3, 4]
Return [] if all discovered flows are already covered.
Return JSON only, no markdown.`;

export async function deduplicateFlowsWithLLM(
  discovered: DiscoveredFlow[],
  existing: { name: string; intent: string }[],
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<DiscoveredFlow[]> {
  if (discovered.length === 0) return [];
  if (existing.length === 0) return discovered;

  const config = getConfig();
  const model = config.auxiliaryModel;

  const existingList = existing
    .map((f, i) => `${i + 1}. "${f.name}": ${f.intent}`)
    .join("\n");
  const discoveredList = discovered
    .map((f, i) => `${i + 1}. "${f.name}": ${f.intent}`)
    .join("\n");

  const userPrompt =
    `Existing flows (${existing.length}):\n${existingList}\n\n` +
    `Newly discovered flows (${discovered.length}):\n${discoveredList}\n\n` +
    `Which of the newly discovered flows are genuinely new (not covered by existing)?`;

  const messages = [
    { role: "system" as const, content: DEDUP_SYSTEM },
    { role: "user" as const, content: [{ type: "text" as const, text: userPrompt }] },
  ];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(messages, model, { maxTokens: 500, temperature: 0 });
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "auxiliaryModel");

    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    const llmCall: Omit<LLMCallRecord, "seq"> = {
      stepIndex: 71_001,
      model,
      hasVision: false,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd,
      query: `Flow dedup (${discovered.length} new vs ${existing.length} existing)`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      response: raw,
      agent: "flow_discovery",
    };
    opts?.onLLMCall?.(llmCall);

    const parsed = parseFirstJsonObject<number[]>(raw);
    if (!Array.isArray(parsed)) {
      logger.warn({ raw }, "Flow dedup: unexpected LLM response, keeping all discovered flows");
      return discovered;
    }

    const newFlows = parsed
      .filter((i) => typeof i === "number" && i >= 1 && i <= discovered.length)
      .map((i) => discovered[i - 1]);

    logger.info({ discovered: discovered.length, existing: existing.length, new: newFlows.length }, "Flow dedup: result");
    return newFlows;
  } catch (err) {
    logger.warn({ err: String(err) }, "Flow dedup: LLM call failed, falling back to keeping all");
    return discovered;
  }
}

export async function runFlowDiscoveryAgent(
  stepsDetail: RunStep[],
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<FlowDiscoveryResult> {
  if (stepsDetail.length === 0) {
    return { flows: [], llmCall: null };
  }

  const config = getConfig();
  const model = config.auxiliaryModel;
  const pageMap = compactStepsForDiscovery(stepsDetail);

  const userPrompt =
    `Pages and sections discovered during exploration:\n\n${pageMap}\n\n` +
    `Based on what this application does, identify the 5-10 most important user flows worth testing.`;

  const messages = [
    { role: "system" as const, content: DISCOVERY_SYSTEM },
    { role: "user" as const, content: [{ type: "text" as const, text: userPrompt }] },
  ];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(messages, model, {
      maxTokens: 2000,
      temperature: 0.3,
    });
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "auxiliaryModel");

    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    const llmCall: Omit<LLMCallRecord, "seq"> = {
      stepIndex: 71_000,
      model,
      hasVision: false,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd,
      query: `Flow discovery (${stepsDetail.length} steps, ${pageMap.split("URL:").length - 1} pages)`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      response: raw,
      agent: "flow_discovery",
    };
    opts?.onLLMCall?.(llmCall);

    const parsed = parseFirstJsonObject<DiscoveredFlow[] | { flows?: DiscoveredFlow[] }>(raw);
    let flows: DiscoveredFlow[] = [];
    if (Array.isArray(parsed)) {
      flows = parsed;
    } else if (parsed && Array.isArray((parsed as any).flows)) {
      flows = (parsed as any).flows;
    }

    flows = flows
      .filter((f) => f && typeof f.name === "string" && typeof f.intent === "string")
      .map((f) => ({ name: f.name.trim().slice(0, 80), intent: f.intent.trim().slice(0, 600) }))
      .filter((f) => f.name.length > 0 && f.intent.length > 0)
      .slice(0, 10);

    logger.info({ count: flows.length }, "Flow discovery: extracted flows");
    return { flows, llmCall };
  } catch (err) {
    logger.warn({ err: String(err) }, "Flow discovery: LLM call failed");
    return { flows: [], llmCall: null };
  }
}
