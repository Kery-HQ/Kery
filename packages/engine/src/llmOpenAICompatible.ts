import OpenAI from "openai";
import { logger } from "./logger.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

/** Models observed to reject an explicit temperature; populated on first 400. */
const MODELS_REJECTING_TEMPERATURE = new Set<string>();

export type OpenAIStyleChatExtra = {
  /** Merged into the chat-completions body (e.g. OpenRouter `reasoning` for Gemini). */
  bodyExtensions?: Record<string, unknown>;
};

/**
 * Chat Completions via the OpenAI SDK (OpenAI API, OpenRouter, or any compatible base URL).
 */
export async function openAIStyleChat(
  apiKey: string,
  baseURL: string | undefined,
  defaultHeaders: Record<string, string>,
  wireModel: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: LlmChatOpts,
  extra?: OpenAIStyleChatExtra
): Promise<{ content: string; usage: LLMUsage }> {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const client = new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
    defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
    timeout: timeoutMs,
  });

  const body: Record<string, unknown> = {
    model: wireModel,
    messages,
    max_completion_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
  };
  // Only send a temperature to models that have not already rejected one.
  // Without this the retry below fires on EVERY call to such a model: a run was
  // making 106 requests to serve 53, doubling latency and cost throughout.
  if (!MODELS_REJECTING_TEMPERATURE.has(wireModel)) {
    body.temperature = opts.temperature ?? 0.1;
  }
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (extra?.bodyExtensions) Object.assign(body, extra.bodyExtensions);

  // Newer model families (gpt-5.6, reasoning models) accept only the default
  // temperature and 400 on anything else. Discover that once per model at
  // runtime and remember it, rather than maintaining a hand-written capability
  // list that rots as models change.
  let completion;
  try {
    completion = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      opts.signal ? { signal: opts.signal } : undefined
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/temperature/i.test(message) || !("temperature" in body)) throw err;
    logger.info({ model: wireModel }, "Model rejects custom temperature — retrying without it and remembering for this model");
    MODELS_REJECTING_TEMPERATURE.add(wireModel);
    delete body.temperature;
    completion = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      opts.signal ? { signal: opts.signal } : undefined
    );
  }

  const choice = completion.choices?.[0];
  if (!choice) {
    throw new Error(`LLM returned no choices: ${JSON.stringify(completion).slice(0, 300)}`);
  }

  const fr = choice.finish_reason as string | null | undefined;
  if (fr === "SAFETY" || fr === "content_filter") {
    logger.warn("LLM SAFETY / content filter triggered");
    return { content: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  if (fr && fr !== "stop" && fr !== "length") {
    logger.warn({ finish_reason: fr, model: wireModel }, "LLM non-stop finish reason");
  }

  const u = completion.usage;
  const usage: LLMUsage = {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0),
  };

  const msg = choice.message;
  let content = "";
  const mc = msg.content;
  if (typeof mc === "string") content = mc;
  else if (Array.isArray(mc)) {
    for (const part of mc as OpenAI.Chat.ChatCompletionContentPart[]) {
      if (part.type === "text" && "text" in part) content += part.text ?? "";
    }
  }

  return { content, usage };
}
