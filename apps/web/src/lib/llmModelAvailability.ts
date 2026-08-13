/**
 * Mirrors packages/engine/src/llmProviders.ts — keep rules in sync when changing providers.
 */
export type CustomProviderId = "openai" | "anthropic" | "gemini" | "openrouter" | "custom";

export type LlmKeyPresence = {
  hasOpenRouter: boolean;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  hasGemini: boolean;
  /** Custom OpenAI-compatible endpoint configured (base URL present). */
  hasCustom: boolean;
};

const OPENROUTER_ONLY_PREFIXES = ["deepseek/", "meta/", "mistral/", "cohere/", "perplexity/", "qwen/"];

/** Model ids with this prefix always route to the custom OpenAI-compatible endpoint. */
export const CUSTOM_MODEL_PREFIX = "custom/";

function inferDirectProvider(
  model: string
): "openai" | "anthropic" | "gemini" | "custom" | "openrouter_only" {
  const m = model.trim();
  if (m.startsWith(CUSTOM_MODEL_PREFIX)) return "custom";
  if (m.startsWith("openai/") || m.startsWith("gpt-")) return "openai";
  if (m.startsWith("anthropic/") || m.startsWith("claude")) return "anthropic";
  if (m.startsWith("google/") || m.startsWith("gemini-")) return "gemini";
  for (const p of OPENROUTER_ONLY_PREFIXES) {
    if (m.startsWith(p)) return "openrouter_only";
  }
  return "openrouter_only";
}

/** Whether the user can select this model id given which API keys exist (mirrors engine `isModelRunnableWithConfig`). */
export function isModelSelectable(modelId: string, keys: LlmKeyPresence): boolean {
  const p = inferDirectProvider(modelId);
  if (p === "custom") return keys.hasCustom;
  if (keys.hasOpenRouter || keys.hasCustom) return true;
  if (p === "openrouter_only") return false;
  if (p === "openai") return keys.hasOpenAI;
  if (p === "anthropic") return keys.hasAnthropic;
  return keys.hasGemini;
}

export function modelMissingKeyLabel(modelId: string, keys: LlmKeyPresence): string | null {
  const p = inferDirectProvider(modelId);
  if (p === "custom") return keys.hasCustom ? null : "Requires a custom endpoint (Settings → API Keys)";
  if (keys.hasOpenRouter || keys.hasCustom) return null;
  if (p === "openrouter_only") return "Requires OpenRouter";
  if (p === "openai" && !keys.hasOpenAI) return "Missing OPENAI_API_KEY or OPENROUTER_API_KEY";
  if (p === "anthropic" && !keys.hasAnthropic) return "Missing ANTHROPIC_API_KEY or OPENROUTER_API_KEY";
  if (p === "gemini" && !keys.hasGemini) return "Missing GEMINI_API_KEY or OPENROUTER_API_KEY";
  return null;
}

/** Build stored model id from Settings "custom model" fields (must match engine routing). */
export function composeCustomModel(provider: CustomProviderId, raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  switch (provider) {
    case "openai":
      if (t.startsWith("openai/") || t.startsWith("gpt-")) return t;
      return `openai/${t}`;
    case "anthropic":
      if (t.startsWith("anthropic/") || t.startsWith("claude")) return t;
      return `anthropic/${t}`;
    case "gemini":
      if (t.startsWith("google/") || t.startsWith("gemini-")) return t;
      return `google/${t}`;
    case "custom":
      if (t.startsWith(CUSTOM_MODEL_PREFIX)) return t;
      return `${CUSTOM_MODEL_PREFIX}${t}`;
    case "openrouter":
      return t;
  }
}

/** Split a stored id back into provider + short id for the custom form. */
export function parseStoredModelForCustomUi(model: string): { provider: CustomProviderId; raw: string } {
  const m = model.trim();
  if (!m) return { provider: "openrouter", raw: "" };
  if (m.startsWith(CUSTOM_MODEL_PREFIX)) return { provider: "custom", raw: m.slice(CUSTOM_MODEL_PREFIX.length) };
  if (m.startsWith("openai/")) return { provider: "openai", raw: m.slice("openai/".length) };
  if (m.startsWith("gpt-")) return { provider: "openai", raw: m };
  if (m.startsWith("anthropic/")) return { provider: "anthropic", raw: m.slice("anthropic/".length) };
  if (m.startsWith("claude")) return { provider: "anthropic", raw: m };
  if (m.startsWith("google/")) return { provider: "gemini", raw: m.slice("google/".length) };
  if (m.startsWith("gemini-")) return { provider: "gemini", raw: m };
  for (const p of OPENROUTER_ONLY_PREFIXES) {
    if (m.startsWith(p)) return { provider: "openrouter", raw: m };
  }
  return { provider: "openrouter", raw: m };
}
