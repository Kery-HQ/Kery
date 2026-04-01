import type OpenAI from "openai";
import { wireModelForOpenAIDirect } from "./llmProviders.js";
import { openAIStyleChat } from "./llmOpenAICompatible.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";

export async function llmOpenAIChat(
  messages: unknown[],
  model: string,
  apiKey: string,
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const wireModel = wireModelForOpenAIDirect(model);
  return openAIStyleChat(
    apiKey,
    OPENAI_API_BASE,
    {},
    wireModel,
    messages as OpenAI.Chat.ChatCompletionMessageParam[],
    opts
  );
}

export { OPENAI_API_BASE };
