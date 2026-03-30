/** Provider ceiling for completion length (OpenRouter/Gemini-style cap). Use everywhere we pass `max_tokens`. */
export const MAX_OUTPUT_TOKENS = 65535;

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
