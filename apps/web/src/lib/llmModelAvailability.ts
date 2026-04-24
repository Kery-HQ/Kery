/**
 * Mirrors packages/engine/src/llmProviders.ts — keep rules in sync when changing providers.
 */
export type CustomProviderId = "openai" | "anthropic" | "gemini" | "openrouter";

export type LlmKeyPresence = {
  hasOpenRouter: boolean;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  hasGemini: boolean;
};

const OPENROUTER_ONLY_PREFIXES = ["deepseek/", "meta/", "mistral/", "cohere/", "perplexity/", "qwen/"];

// Model ID prefixes that use a known direct-provider prefix (google/) but are
// only available on OpenRouter right now. Must be checked before the provider check.
const OPENROUTER_ONLY_MODEL_PREFIXES = ["google/gemini-3"];

function inferDirectProvider(
  model: string
): "openai" | "anthropic" | "gemini" | "openrouter_only" {
  const m = model.trim();
  // Check OpenRouter-only model prefixes before provider-level checks
  for (const p of OPENROUTER_ONLY_MODEL_PREFIXES) {
    if (m.startsWith(p)) return "openrouter_only";
  }
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
  if (keys.hasOpenRouter) return true;
  const p = inferDirectProvider(modelId);
  if (p === "openrouter_only") return false;
  if (p === "openai") return keys.hasOpenAI;
  if (p === "anthropic") return keys.hasAnthropic;
  return keys.hasGemini;
}

export function modelMissingKeyLabel(modelId: string, keys: LlmKeyPresence): string | null {
  if (keys.hasOpenRouter) return null;
  const p = inferDirectProvider(modelId);
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
    case "openrouter":
      return t;
  }
}

/** Split a stored id back into provider + short id for the custom form. */
export function parseStoredModelForCustomUi(model: string): { provider: CustomProviderId; raw: string } {
  const m = model.trim();
  if (!m) return { provider: "openrouter", raw: "" };
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
