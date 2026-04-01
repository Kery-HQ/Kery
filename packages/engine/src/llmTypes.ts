/** Provider ceiling for completion length (OpenRouter/Gemini-style cap). Use everywhere we pass `max_tokens`. */
export const MAX_OUTPUT_TOKENS = 65535;

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Options passed through `llmChat` to provider implementations. */
export type LlmChatOpts = {
  maxTokens?: number;
  temperature?: number;
  responseFormat?: unknown;
  timeoutMs?: number;
};
