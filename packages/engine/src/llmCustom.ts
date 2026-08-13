import type OpenAI from "openai";
import { getConfig } from "./config.js";
import { openAIStyleChat } from "./llmOpenAICompatible.js";
import { wireModelForCustomEndpoint } from "./llmProviders.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";

/** The OpenAI SDK rejects an empty apiKey; local endpoints (Ollama, LM Studio) accept any value. */
const NO_KEY_PLACEHOLDER = "sk-no-key";

/** Chat via the user-configured OpenAI-compatible endpoint (Azure, DashScope, Ollama, LiteLLM, …). */
export async function llmCustomChat(
  messages: unknown[],
  model: string,
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const cfg = getConfig();
  if (!cfg.customLlmBaseUrl) {
    throw new Error("Custom LLM endpoint not configured — set CUSTOM_LLM_BASE_URL or add one in Settings");
  }
  return openAIStyleChat(
    cfg.customLlmApiKey || NO_KEY_PLACEHOLDER,
    cfg.customLlmBaseUrl,
    {},
    wireModelForCustomEndpoint(model),
    messages as OpenAI.Chat.ChatCompletionMessageParam[],
    opts
  );
}
