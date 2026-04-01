import type OpenAI from "openai";
import { getConfig } from "./config.js";
import { openAIStyleChat } from "./llmOpenAICompatible.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

const REFERER_URL = "https://kery.so";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const OPENROUTER_HEADERS = {
  "HTTP-Referer": REFERER_URL,
  "X-Title": "Kery Agent",
};

export async function llmOpenRouterChat(
  messages: unknown[],
  model: string,
  apiKey: string,
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const wireModel =
    model.startsWith("gemini-") && !model.includes("/") ? `google/${model}` : model;

  const reasoningGemini = wireModel.startsWith("google/gemini");
  const timeoutMs = opts.timeoutMs ?? getConfig().llmTimeoutMs;

  return openAIStyleChat(
    apiKey,
    OPENROUTER_BASE,
    OPENROUTER_HEADERS,
    wireModel,
    messages as OpenAI.Chat.ChatCompletionMessageParam[],
    { ...opts, timeoutMs },
    reasoningGemini
      ? {
          bodyExtensions: {
            reasoning: {
              max_tokens: MAX_OUTPUT_TOKENS,
              enabled: true,
              exclude: false,
            },
          },
        }
      : undefined
  );
}

export { OPENROUTER_BASE };
