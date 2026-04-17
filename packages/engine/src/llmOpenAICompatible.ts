import OpenAI from "openai";
import { logger } from "./logger.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

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
    max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    temperature: opts.temperature ?? 0.1,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (extra?.bodyExtensions) Object.assign(body, extra.bodyExtensions);

  const completion = await client.chat.completions.create(
    body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    opts.signal ? { signal: opts.signal } : undefined
  );

  const choice = completion.choices[0];
  if (!choice) {
    throw new Error(`LLM returned no choices: ${JSON.stringify(completion).slice(0, 200)}`);
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
