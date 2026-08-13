import type { EngineConfig } from "./config.js";

/** How a model is reached when OpenRouter is not configured. */
export type DirectModelProvider = "openai" | "anthropic" | "gemini";

export type ModelProviderRequirement =
  | { kind: "direct"; provider: DirectModelProvider }
  | { kind: "custom" }
  | { kind: "openrouter_only"; hint: string };

const OPENROUTER_ONLY_PREFIXES = ["deepseek/", "meta/", "mistral/", "cohere/", "perplexity/", "qwen/"];

/** Model ids with this prefix always route to the custom OpenAI-compatible endpoint. */
export const CUSTOM_MODEL_PREFIX = "custom/";

/** True when a custom OpenAI-compatible endpoint is configured (API key optional). */
export function hasCustomEndpoint(cfg: EngineConfig): boolean {
  return !!cfg.customLlmBaseUrl;
}

/**
 * Classify which direct provider matches `model`. OpenRouter or a custom endpoint can
 * still satisfy the call when the matching direct key is missing (see `isModelRunnableWithConfig`).
 */
export function inferModelProviderRequirement(model: string): ModelProviderRequirement {
  const m = model.trim();
  if (!m) return { kind: "openrouter_only", hint: "Empty model id" };

  if (m.startsWith(CUSTOM_MODEL_PREFIX)) {
    return { kind: "custom" };
  }
  if (m.startsWith("openai/") || m.startsWith("gpt-")) {
    return { kind: "direct", provider: "openai" };
  }
  if (m.startsWith("anthropic/") || m.startsWith("claude")) {
    return { kind: "direct", provider: "anthropic" };
  }
  if (m.startsWith("google/") || m.startsWith("gemini-")) {
    return { kind: "direct", provider: "gemini" };
  }

  for (const p of OPENROUTER_ONLY_PREFIXES) {
    if (m.startsWith(p)) return { kind: "openrouter_only", hint: "Provider available via OpenRouter only" };
  }

  return { kind: "openrouter_only", hint: "Configure OPENROUTER_API_KEY for this model" };
}

export function hasDirectProviderKey(cfg: EngineConfig, provider: DirectModelProvider): boolean {
  switch (provider) {
    case "openai":
      return !!cfg.openaiApiKey;
    case "anthropic":
      return !!cfg.anthropicApiKey;
    case "gemini":
      return !!cfg.geminiApiKey;
    default:
      return false;
  }
}

/** True if the engine can run API calls for this model id with the given config. */
export function isModelRunnableWithConfig(model: string, cfg: EngineConfig): boolean {
  const req = inferModelProviderRequirement(model);
  if (req.kind === "custom") return hasCustomEndpoint(cfg);
  if (req.kind === "openrouter_only") return !!cfg.openrouterApiKey || hasCustomEndpoint(cfg);
  return hasDirectProviderKey(cfg, req.provider) || !!cfg.openrouterApiKey || hasCustomEndpoint(cfg);
}

/** Human-readable reason when `isModelRunnableWithConfig` is false (no secrets). */
export function modelUnavailableReason(model: string, cfg: EngineConfig): string | null {
  if (isModelRunnableWithConfig(model, cfg)) return null;
  const req = inferModelProviderRequirement(model);
  if (req.kind === "custom") {
    return "Models with a custom/ prefix require a custom endpoint — set CUSTOM_LLM_BASE_URL";
  }
  if (req.kind === "openrouter_only") {
    return req.hint ?? "Configure OPENROUTER_API_KEY for this model";
  }
  const keyName =
    req.provider === "openai"
      ? "OPENAI_API_KEY"
      : req.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "GEMINI_API_KEY";
  return `Missing ${keyName}, OPENROUTER_API_KEY, or CUSTOM_LLM_BASE_URL`;
}

/** Which provider API keys are present (for Settings UI). Never exposes key values. */
export function getLlmKeyPresence(cfg: EngineConfig): {
  hasOpenRouter: boolean;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  hasGemini: boolean;
  hasCustom: boolean;
} {
  return {
    hasOpenRouter: !!cfg.openrouterApiKey,
    hasOpenAI: !!cfg.openaiApiKey,
    hasAnthropic: !!cfg.anthropicApiKey,
    hasGemini: !!cfg.geminiApiKey,
    hasCustom: hasCustomEndpoint(cfg),
  };
}

export function wireModelForOpenAIDirect(model: string): string {
  if (model.startsWith("openai/")) return model.slice("openai/".length);
  return model;
}

/** Google AI Studio OpenAI-compatible API uses plain Gemini model ids (no google/ prefix). */
export function wireModelForGeminiDirect(model: string): string {
  if (model.startsWith("google/")) return model.slice("google/".length);
  return model;
}

/** Custom endpoints receive the model id verbatim, minus the routing-only custom/ prefix. */
export function wireModelForCustomEndpoint(model: string): string {
  if (model.startsWith(CUSTOM_MODEL_PREFIX)) return model.slice(CUSTOM_MODEL_PREFIX.length);
  return model;
}
