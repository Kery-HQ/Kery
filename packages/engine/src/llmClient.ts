import { getConfig } from "./config.js";
import { logger } from "./logger.js";

const REFERER_URL = "https://kery.so";

// We route all LLM traffic through OpenRouter (if configured) or fall back to OpenAI.
export function getLLMBase(): string {
  const config = getConfig();
  return config.openrouterApiKey
    ? "https://openrouter.ai/api/v1"
    : "https://api.openai.com/v1";
}

/** Max output tokens allowed by providers (Gemini/OpenRouter); use for all LLM calls to avoid truncation. */
export const MAX_OUTPUT_TOKENS = 65535;

// ─── Structured output schemas ──────────────────────────────────────────────

const ACTION_ENUM = ["fill", "click", "navigate", "assert", "wait", "done", "hover", "scroll", "pressKey", "selectOption", "back"];

function isOpenAIModel(model: string): boolean {
  return model.startsWith("openai/") || model.startsWith("gpt-");
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
        assertion: { anyOf: [{ type: "string" }, { type: "null" }] },
        reasoning: { type: "string" },
      },
      required: ["action", "element", "target", "value", "x", "y", "assertion", "reasoning"],
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
        assertion: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["action", "reasoning"],
      additionalProperties: false,
    },
  },
};

function getAgentSchema(model: string) {
  return isOpenAIModel(model) ? OPENAI_AGENT_SCHEMA : GEMINI_AGENT_SCHEMA;
}

// ─── Usage / pricing ─────────────────────────────────────────────────────────

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash-lite":       { input: 0.075, output: 0.30 },
  "gemini-2.5-flash":            { input: 0.15,  output: 0.60 },
  "gemini-2.0-flash":            { input: 0.10,  output: 0.40 },
  "gemini-1.5-flash":            { input: 0.075, output: 0.30 },
  "gemini-1.5-pro":              { input: 1.25,  output: 5.00 },
  "openai/gpt-4o-mini":          { input: 0.15,  output: 0.60 },
  "openai/gpt-4o":               { input: 2.50,  output: 10.00 },
  "openai/gpt-5-nano":           { input: 0.05,  output: 0.40 },
  "openai/gpt-5":                { input: 1.25,  output: 10.00 },
  "anthropic/claude-sonnet-4.6": { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-4.5":  { input: 1.00,  output: 5.00 },
  "anthropic/claude-opus-4.6":   { input: 15.00, output: 75.00 },
};

export function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(MODEL_PRICING)
    .filter(k => model.startsWith(k) || model === k)
    .sort((a, b) => b.length - a.length)[0] ?? "openai/gpt-4o-mini";
  const p = MODEL_PRICING[key];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ─── Low-level chat ───────────────────────────────────────────────────────────

export async function llmChat(
  messages: any[],
  model: string,
  opts: { maxTokens?: number; temperature?: number; responseFormat?: any; timeoutMs?: number } = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const config = getConfig();
  const apiKey = config.openrouterApiKey || config.openaiApiKey;
  if (!apiKey) throw new Error("No LLM API key configured (OPENROUTER_API_KEY or OPENAI_API_KEY).");

  const wireModel =
    config.openrouterApiKey && model.startsWith("gemini-") && !model.includes("/")
      ? `google/${model}`
      : model;

  const body: any = {
    model: wireModel,
    messages,
    max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    temperature: opts.temperature ?? 0.1,
  };

  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }

  if (config.openrouterApiKey && wireModel.startsWith("google/gemini-")) {
    body.reasoning = {
      max_tokens: 20000,
      enabled: true,
      exclude: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? config.llmTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${getLLMBase()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(config.openrouterApiKey ? { "HTTP-Referer": REFERER_URL, "X-Title": "Kery Agent" } : {}),
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
    logger.warn({ finish_reason: choice.finish_reason, model }, "LLM non-stop finish reason");
  }

  const usage: LLMUsage = {
    inputTokens:  data.usage?.prompt_tokens     ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    totalTokens:  data.usage?.total_tokens      ?? 0,
  };

  return { content: choice.message?.content ?? "", usage };
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
              type: { type: "string", enum: ["visual", "ux", "behavioral"] },
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
