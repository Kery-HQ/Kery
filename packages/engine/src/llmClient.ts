import { getConfig, type ModelConfigKey } from "./config.js";
import { logger } from "./logger.js";
import { anthropicMessagesChat } from "./llmAnthropic.js";
import {
  inferModelProviderRequirement,
  wireModelForGeminiDirect,
  wireModelForOpenAIDirect,
  isModelRunnableWithConfig,
  modelUnavailableReason,
} from "./llmProviders.js";
import type { LLMUsage } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

export type { LLMUsage } from "./llmTypes.js";
export { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

const REFERER_URL = "https://kery.so";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Base URL for OpenRouter, or OpenAI when using direct OpenAI without OpenRouter (legacy helper). */
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

function getAgentSchema(model: string): any | undefined {
  if (isOpenAIModel(model)) return OPENAI_AGENT_SCHEMA;
  if (isAnthropicModel(model)) return undefined;
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

async function openAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  wireModel: string,
  messages: any[],
  opts: { maxTokens?: number; temperature?: number; responseFormat?: any; timeoutMs?: number },
  options: { reasoningGemini?: boolean }
): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const body: any = {
    model: wireModel,
    messages,
    max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    temperature: opts.temperature ?? 0.1,
  };

  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }

  if (options.reasoningGemini) {
    body.reasoning = {
      max_tokens: MAX_OUTPUT_TOKENS,
      enabled: true,
      exclude: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? config.llmTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`LLM call timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text}`);
  }

  const data: any = await res.json();
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error(`LLM returned no choices: ${JSON.stringify(data).slice(0, 200)}`);
  }

  if (choice.finish_reason === "SAFETY") {
    logger.warn("LLM SAFETY filter triggered");
    return { content: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  if (choice.finish_reason && choice.finish_reason !== "stop") {
    logger.warn({ finish_reason: choice.finish_reason, model: wireModel }, "LLM non-stop finish reason");
  }

  const usage: LLMUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };

  return { content: choice.message?.content ?? "", usage };
}

async function llmChatOpenRouter(
  messages: any[],
  model: string,
  opts: { maxTokens?: number; temperature?: number; responseFormat?: any; timeoutMs?: number }
): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const apiKey = config.openrouterApiKey!;
  const wireModel =
    model.startsWith("gemini-") && !model.includes("/") ? `google/${model}` : model;

  return openAICompatibleChat(
    "https://openrouter.ai/api/v1",
    apiKey,
    { "HTTP-Referer": REFERER_URL, "X-Title": "Kery Agent" },
    wireModel,
    messages,
    opts,
    { reasoningGemini: wireModel.startsWith("google/gemini") }
  );
}

function llmProviderLabel(model: string): string {
  const config = getConfig();
  if (config.openrouterApiKey) return "openrouter";
  if (!isModelRunnableWithConfig(model, config)) return "unconfigured";
  const req = inferModelProviderRequirement(model);
  if (req.kind !== "direct") return "openrouter-required";
  return req.provider;
}

export async function llmChat(
  messages: any[],
  model: string,
  opts: { maxTokens?: number; temperature?: number; responseFormat?: any; timeoutMs?: number } = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const timeoutMs = opts.timeoutMs ?? config.llmTimeoutMs;
  const provider = llmProviderLabel(model);
  const structured = Boolean(opts.responseFormat);
  const t0 = Date.now();
  logger.info(
    { provider, model, timeoutMs, structured, messageCount: messages.length },
    "LLM request start",
  );

  try {
    let result: { content: string; usage: LLMUsage };

    if (config.openrouterApiKey) {
      result = await llmChatOpenRouter(messages, model, opts);
    } else if (!isModelRunnableWithConfig(model, config)) {
      throw new Error(
        modelUnavailableReason(model, config) ??
          'No LLM API key configured. Set OPENROUTER_API_KEY or the provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).'
      );
    } else {
      const req = inferModelProviderRequirement(model);
      if (req.kind !== "direct") {
        throw new Error(`Model "${model}" requires OPENROUTER_API_KEY.`);
      }

      if (req.provider === "anthropic") {
        result = await anthropicMessagesChat(messages, model, config.anthropicApiKey, { ...opts, timeoutMs });
      } else if (req.provider === "openai") {
        const wireModel = wireModelForOpenAIDirect(model);
        result = await openAICompatibleChat(
          OPENAI_API_BASE,
          config.openaiApiKey,
          {},
          wireModel,
          messages,
          opts,
          { reasoningGemini: false }
        );
      } else {
        const wireGemini = wireModelForGeminiDirect(model);
        result = await openAICompatibleChat(
          GEMINI_OPENAI_BASE,
          config.geminiApiKey,
          {},
          wireGemini,
          messages,
          opts,
          { reasoningGemini: false }
        );
      }
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

export async function llmAgentChat(messages: any[]): Promise<{ content: string; usage: LLMUsage }> {
  const model = getConfig().agentModel;
  return llmChat(messages, model, {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.5,
    responseFormat: getAgentSchema(model),
  });
}

// ─── Summarization (text only) ────────────────────────────────────────────────

export async function llmSummarize(prompt: string): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
  const { content, usage } = await llmChat(
    [{ role: "user", content: prompt }],
    getConfig().summaryModel,
    { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 }
  );
  return { content, usage };
}

// ─── Review Agent (vision + text, structured bugs) ─────────────────────────────

const REVIEW_BUG_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "review_bugs",
    strict: true,
    schema: {
      type: "object",
      properties: {
        bugs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["visual", "ux", "behavioral", "a11y", "performance", "data"] },
              description: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              region: {
                type: "object",
                properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } },
                required: ["x", "y", "w", "h"],
                additionalProperties: false,
              },
            },
            required: ["type", "description", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["bugs"],
      additionalProperties: false,
    },
  },
};

export async function llmReviewAnalysis(messages: any[]): Promise<{ content: string; usage: LLMUsage }> {
  const model = getConfig().reviewModel ?? "gemini-2.5-flash-lite";
  return llmChat(messages, model, {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    responseFormat: REVIEW_BUG_SCHEMA,
  });
}

// ─── Path Generator (text only, structured test plan) ──────────────────────────

const PATH_STEP_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["navigate", "click", "fill", "assert", "wait", "hover", "scroll", "pressKey", "selectOption", "back"] },
    target: { type: "string" },
    value: { type: "string" },
    expectation: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["action", "target", "reasoning"],
  additionalProperties: false,
};

const TEST_PLAN_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "test_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        happyPaths: { type: "array", items: { type: "array", items: PATH_STEP_SCHEMA } },
        sadPaths: { type: "array", items: { type: "array", items: PATH_STEP_SCHEMA } },
        edgeCases: { type: "array", items: { type: "array", items: PATH_STEP_SCHEMA } },
        interactionFlows: { type: "array", items: { type: "array", items: PATH_STEP_SCHEMA } },
        regressionChecks: { type: "array", items: { type: "array", items: PATH_STEP_SCHEMA } },
      },
      required: ["happyPaths", "sadPaths", "edgeCases", "interactionFlows", "regressionChecks"],
      additionalProperties: false,
    },
  },
};

export async function llmPathPlan(prompt: string): Promise<{ content: string; usage: LLMUsage }> {
  const model = getConfig().reviewModel ?? "gemini-2.5-flash-lite";
  return llmChat(
    [{ role: "user", content: prompt }],
    model,
    { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3, responseFormat: TEST_PLAN_SCHEMA }
  );
}
