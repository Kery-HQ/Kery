import { getConfig, type ModelConfigKey } from "./config.js";
import { logger } from "./logger.js";
import { anthropicMessagesChat } from "./llmAnthropic.js";
import { llmGeminiChat } from "./llmGemini.js";
import { llmOpenAIChat, OPENAI_API_BASE } from "./llmOpenAI.js";
import { llmOpenRouterChat } from "./llmOpenRouter.js";
import {
  inferModelProviderRequirement,
  hasDirectProviderKey,
  modelUnavailableReason,
} from "./llmProviders.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

export type { LLMUsage } from "./llmTypes.js";
export { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

type LlmRoute =
  | { kind: "openai" }
  | { kind: "anthropic" }
  | { kind: "gemini" }
  | { kind: "openrouter" }
  | { kind: "none"; reason: string };

/** Prefer the matching direct provider when its key is set; otherwise OpenRouter if configured. */
function pickLlmRoute(model: string, cfg: ReturnType<typeof getConfig>): LlmRoute {
  const req = inferModelProviderRequirement(model);
  if (req.kind === "openrouter_only") {
    if (cfg.openrouterApiKey) return { kind: "openrouter" };
    return { kind: "none", reason: req.hint ?? `Model "${model}" requires OPENROUTER_API_KEY.` };
  }
  if (hasDirectProviderKey(cfg, req.provider)) {
    return { kind: req.provider };
  }
  if (cfg.openrouterApiKey) return { kind: "openrouter" };
  return {
    kind: "none",
    reason:
      modelUnavailableReason(model, cfg) ??
      "No LLM API key configured. Set OPENROUTER_API_KEY or the provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).",
  };
}

/** Base URL for OpenRouter, or OpenAI when no OpenRouter key (UI / diagnostics helper). */
export function getLLMBase(): string {
  const config = getConfig();
  return config.openrouterApiKey ? "https://openrouter.ai/api/v1" : OPENAI_API_BASE;
}

// ─── Structured output schemas ──────────────────────────────────────────────

const ACTION_ENUM = [
  "fill",
  "click",
  "navigate",
  "assert",
  "wait",
  "done",
  "hover",
  "scroll",
  "pressKey",
  "selectOption",
  "back",
  "dragAndDrop",
  "setDate",
  "observe",
  "plan",
  "report_bug",
];

function isOpenAIModel(model: string): boolean {
  return model.startsWith("openai/") || model.startsWith("gpt-");
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("claude-");
}

const OPENAI_AGENT_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "agent_action",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action:    { type: "string", enum: ACTION_ENUM },
        element:   { anyOf: [{ type: "integer" }, { type: "null" }] },
        target:    { anyOf: [{ type: "string" }, { type: "null" }] },
        value:     { anyOf: [{ type: "string" }, { type: "null" }] },
        x:         { anyOf: [{ type: "integer" }, { type: "null" }] },
        y:         { anyOf: [{ type: "integer" }, { type: "null" }] },
        toX:       { anyOf: [{ type: "integer" }, { type: "null" }] },
        toY:       { anyOf: [{ type: "integer" }, { type: "null" }] },
        assertion: { anyOf: [{ type: "string" }, { type: "null" }] },
        observation: { anyOf: [{ type: "string" }, { type: "null" }] },
        result:    { anyOf: [{ type: "string", enum: ["completed", "blocked"] }, { type: "null" }] },
        planItems: {
          anyOf: [
            {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      status: { type: "string", enum: ["pending", "done", "current", "failed"] },
                    },
                    // OpenAI/Azure strict JSON schema: required must list every key in properties.
                    required: ["text", "status"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            { type: "null" },
          ],
        },
        bugDescription: { anyOf: [{ type: "string" }, { type: "null" }] },
        bugType:    { anyOf: [{ type: "string", enum: ["visual", "functional", "ux", "other"] }, { type: "null" }] },
        severity:   { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }] },
        reasoning: { type: "string" },
      },
      required: [
        "action", "element", "target", "value", "x", "y", "toX", "toY",
        "assertion", "observation", "result", "planItems", "bugDescription", "bugType", "severity", "reasoning",
      ],
      additionalProperties: false,
    },
  },
};

const GEMINI_AGENT_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "agent_action",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action:    { type: "string", enum: ACTION_ENUM },
        element:   { type: "integer", description: "Element number from the interactive elements list" },
        target:    { type: "string" },
        value:     { type: "string" },
        x:         { type: "integer", description: "Optional x coordinate (0-1000) for scroll/hover fallback" },
        y:         { type: "integer", description: "Optional y coordinate (0-1000) for scroll/hover fallback" },
        toX:       { type: "integer", description: "Destination x for dragAndDrop (0-1000)" },
        toY:       { type: "integer", description: "Destination y for dragAndDrop (0-1000)" },
        assertion: { type: "string" },
        observation: { type: "string" },
        result:    { type: "string", enum: ["completed", "blocked"] },
        planItems: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string" },
                  status: { type: "string", enum: ["pending", "done", "current", "failed"] },
                },
                required: ["text", "status"],
                additionalProperties: false,
              },
            ],
          },
        },
        bugDescription: { type: "string" },
        bugType:    { type: "string", enum: ["visual", "functional", "ux", "other"] },
        severity:   { type: "string", enum: ["low", "medium", "high"] },
        reasoning: { type: "string" },
      },
      required: ["action", "reasoning"],
      additionalProperties: false,
    },
  },
};

// Anthropic tool schemas support standard JSON Schema Draft 7 including anyOf/enum.
// Re-use the same shape as OpenAI so all fields are enforced.
const ANTHROPIC_AGENT_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "agent_action",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action:      { type: "string", enum: ACTION_ENUM },
        element:     { anyOf: [{ type: "integer" }, { type: "null" }] },
        target:      { anyOf: [{ type: "string" }, { type: "null" }] },
        value:       { anyOf: [{ type: "string" }, { type: "null" }] },
        x:           { anyOf: [{ type: "integer" }, { type: "null" }] },
        y:           { anyOf: [{ type: "integer" }, { type: "null" }] },
        toX:         { anyOf: [{ type: "integer" }, { type: "null" }] },
        toY:         { anyOf: [{ type: "integer" }, { type: "null" }] },
        assertion:   { anyOf: [{ type: "string" }, { type: "null" }] },
        observation: { anyOf: [{ type: "string" }, { type: "null" }] },
        result:      { anyOf: [{ type: "string", enum: ["completed", "blocked"] }, { type: "null" }] },
        planItems: {
          anyOf: [
            {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      text:   { type: "string" },
                      status: { type: "string", enum: ["pending", "done", "current", "failed"] },
                    },
                    required: ["text", "status"],
                  },
                ],
              },
            },
            { type: "null" },
          ],
        },
        bugDescription: { anyOf: [{ type: "string" }, { type: "null" }] },
        bugType:     { anyOf: [{ type: "string", enum: ["visual", "functional", "ux", "other"] }, { type: "null" }] },
        severity:    { anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }] },
        reasoning:   { type: "string" },
      },
      required: ["action", "reasoning"],
    },
  },
};

/**
 * Anthropic models that support json_schema structured output via OpenRouter.
 * OpenRouter translates the OpenAI-format json_schema to Anthropic tool calls internally.
 * Models NOT in this set (e.g. haiku-4.5) return a malformed response with no `choices`.
 * Source: https://openrouter.ai/docs/guides/features/structured-outputs
 */
const OPENROUTER_ANTHROPIC_STRUCTURED_MODELS = new Set([
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.1",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.6",
]);

/**
 * Returns the structured-output schema for the agent, taking the actual routing into account.
 *
 * - OpenAI direct / OpenRouter OpenAI models → OpenAI json_schema
 * - Anthropic direct SDK → Anthropic tool-call schema (handled in llmAnthropic.ts)
 * - Anthropic via OpenRouter, supported models → OpenAI json_schema format
 *   (OpenRouter translates this to Anthropic tool calls internally)
 * - Anthropic via OpenRouter, unsupported models (e.g. haiku-4.5) → no schema
 *   (prompt-based JSON enforcement handles format correctness)
 * - Gemini → Gemini json_schema
 */
function getAgentSchema(model: string, routeKind: LlmRoute["kind"]): any | undefined {
  if (isAnthropicModel(model)) {
    if (routeKind === "anthropic") return ANTHROPIC_AGENT_SCHEMA;
    if (routeKind === "openrouter" && OPENROUTER_ANTHROPIC_STRUCTURED_MODELS.has(model)) return OPENAI_AGENT_SCHEMA;
    return undefined;
  }
  if (isOpenAIModel(model)) return OPENAI_AGENT_SCHEMA;
  return GEMINI_AGENT_SCHEMA;
}

// ─── Usage / pricing ─────────────────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash-lite":       { input: 0.075, output: 0.30 },
  "gemini-2.5-flash":            { input: 0.15,  output: 0.60 },
  "gemini-2.5-pro":              { input: 1.25,  output: 10.00 },
  "gemini-2.0-flash":            { input: 0.10,  output: 0.40 },
  "gemini-1.5-flash":            { input: 0.075, output: 0.30 },
  "gemini-1.5-pro":              { input: 1.25,  output: 5.00 },
  "openai/gpt-4o-mini":          { input: 0.15,  output: 0.60 },
  "openai/gpt-4o":               { input: 2.50,  output: 10.00 },
  "openai/gpt-4.1-mini":         { input: 0.40,  output: 1.60 },
  "openai/gpt-4.1":              { input: 2.00,  output: 8.00 },
  "openai/gpt-4.1-nano":         { input: 0.10,  output: 0.40 },
  "openai/gpt-5-nano":           { input: 0.05,  output: 0.40 },
  "openai/gpt-5":                { input: 1.25,  output: 10.00 },
  "openai/o3-mini":              { input: 1.10,  output: 4.40 },
  "openai/o3":                   { input: 2.00,  output: 8.00 },
  "anthropic/claude-sonnet-4.6": { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-4.5":  { input: 1.00,  output: 5.00 },
  "anthropic/claude-opus-4.6":   { input: 15.00, output: 75.00 },
  "anthropic/claude-3-5-sonnet": { input: 3.00,  output: 15.00 },
  "anthropic/claude-3-5-haiku":  { input: 0.80,  output: 4.00 },
};

/**
 * @param slot When set, uses custom $/1M rates from config (Settings) for that role if present.
 */
export function calcCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  slot?: ModelConfigKey
): number {
  const cfg = getConfig();
  if (slot && cfg.modelPriceUsdPerMillion?.[slot]) {
    const p = cfg.modelPriceUsdPerMillion[slot]!;
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  }
  const key = Object.keys(MODEL_PRICING)
    .filter((k) => model.startsWith(k) || model === k)
    .sort((a, b) => b.length - a.length)[0] ?? "openai/gpt-4o-mini";
  const p = MODEL_PRICING[key];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ─── Low-level chat ───────────────────────────────────────────────────────────

export async function llmChat(
  messages: any[],
  model: string,
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const timeoutMs = opts.timeoutMs ?? config.llmTimeoutMs;
  const route = pickLlmRoute(model, config);
  if (route.kind === "none") {
    throw new Error(route.reason);
  }
  const provider = route.kind;
  const structured = Boolean(opts.responseFormat);
  const t0 = Date.now();
  logger.info(
    { provider, model, timeoutMs, structured, messageCount: messages.length },
    "LLM request start",
  );

  try {
    let result: { content: string; usage: LLMUsage };

    switch (route.kind) {
      case "openai":
        result = await llmOpenAIChat(messages, model, config.openaiApiKey, { ...opts, timeoutMs });
        break;
      case "anthropic":
        result = await anthropicMessagesChat(messages, model, config.anthropicApiKey, { ...opts, timeoutMs });
        break;
      case "gemini":
        result = await llmGeminiChat(messages, model, config.geminiApiKey, { ...opts, timeoutMs });
        break;
      case "openrouter":
        result = await llmOpenRouterChat(messages, model, config.openrouterApiKey!, { ...opts, timeoutMs });
        break;
    }

    const durationMs = Date.now() - t0;
    logger.info(
      {
        provider,
        model,
        durationMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        responseChars: result.content?.length ?? 0,
      },
      "LLM request complete",
    );
    return result;
  } catch (err) {
    logger.warn(
      {
        provider,
        model,
        durationMs: Date.now() - t0,
        err: err instanceof Error ? err.message : String(err),
      },
      "LLM request failed",
    );
    throw err;
  }
}

// ─── Agent decisions (vision + text) ─────────────────────────────────────────

export async function llmAgentChat(messages: any[], signal?: AbortSignal): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const model = config.agentModel;
  const route = pickLlmRoute(model, config);
  return llmChat(messages, model, {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.5,
    responseFormat: getAgentSchema(model, route.kind),
    signal,
  });
}

// ─── Summarization (text only) ────────────────────────────────────────────────

export async function llmSummarize(prompt: string): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
  const { content, usage } = await llmChat(
    [{ role: "user", content: prompt }],
    getConfig().auxiliaryModel,
    { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 }
  );
  return { content, usage };
}

// ─── Memory curator (text only, structured JSON) ───────────────────────────────

const MEMORY_ADD_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["learned_path", "ignore_region", "avoid_region", "bug_pattern", "tip"],
    },
    summary: { type: "string" },
    content: { type: "string" },
    scope: { type: "string", enum: ["project"] },
    confidence: { type: "integer" },
    regionDescription: { type: ["string", "null"] },
  },
  required: ["type", "summary", "content", "scope", "confidence", "regionDescription"],
  additionalProperties: false,
};

const MEMORY_UPDATE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    summary: { type: ["string", "null"] },
    content: { type: ["string", "null"] },
    confidence: { type: ["integer", "null"] },
  },
  required: ["id", "summary", "content", "confidence"],
  additionalProperties: false,
};

const MEMORY_CURATION_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "memory_curation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        add: { type: "array", items: MEMORY_ADD_ITEM_SCHEMA },
        boost: { type: "array", items: { type: "string" } },
        delete: { type: "array", items: { type: "string" } },
        update: { type: "array", items: MEMORY_UPDATE_ITEM_SCHEMA },
      },
      required: ["add", "boost", "delete", "update"],
      additionalProperties: false,
    },
  },
};

export type MemoryCurationParsed = {
  add: Array<{
    type: "learned_path" | "ignore_region" | "avoid_region" | "bug_pattern" | "tip";
    summary: string;
    content: string;
    scope: "project";
    confidence: number;
    regionDescription: string | null;
  }>;
  boost: string[];
  delete: string[];
  update: Array<{
    id: string;
    summary: string | null;
    content: string | null;
    confidence: number | null;
  }>;
};

export async function llmMemoryCurate(prompt: string): Promise<{ content: string; usage: LLMUsage }> {
  const model = getConfig().auxiliaryModel;
  return llmChat(
    [{ role: "user", content: prompt }],
    model,
    { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2, responseFormat: MEMORY_CURATION_SCHEMA }
  );
}
