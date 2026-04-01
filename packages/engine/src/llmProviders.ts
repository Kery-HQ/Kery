import type { EngineConfig } from "./config.js";

/** How a model is reached when OpenRouter is not configured. */
export type DirectModelProvider = "openai" | "anthropic" | "gemini";

export type ModelProviderRequirement =
  | { kind: "direct"; provider: DirectModelProvider }
  | { kind: "openrouter_only"; hint: string };

const OPENROUTER_ONLY_PREFIXES = ["deepseek/", "meta/", "mistral/", "cohere/", "perplexity/", "qwen/"];

/**
 * Classify which direct provider matches `model`. OpenRouter can still satisfy the call
 * when the matching direct key is missing (see `isModelRunnableWithConfig`).
 */
export function inferModelProviderRequirement(model: string): ModelProviderRequirement {
  const m = model.trim();
  if (!m) return { kind: "openrouter_only", hint: "Empty model id" };

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
  if (req.kind === "openrouter_only") return !!cfg.openrouterApiKey;
  return hasDirectProviderKey(cfg, req.provider) || !!cfg.openrouterApiKey;
}

/** Human-readable reason when `isModelRunnableWithConfig` is false (no secrets). */
export function modelUnavailableReason(model: string, cfg: EngineConfig): string | null {
  if (isModelRunnableWithConfig(model, cfg)) return null;
  const req = inferModelProviderRequirement(model);
  if (req.kind === "openrouter_only") {
    return req.hint ?? "Configure OPENROUTER_API_KEY for this model";
  }
  const keyName =
    req.provider === "openai"
      ? "OPENAI_API_KEY"
      : req.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "GEMINI_API_KEY";
  return `Missing ${keyName} or OPENROUTER_API_KEY`;
}

/** Which provider API keys are present (for Settings UI). Never exposes key values. */
export function getLlmKeyPresence(cfg: EngineConfig): {
  hasOpenRouter: boolean;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  hasGemini: boolean;
} {
  return {
    hasOpenRouter: !!cfg.openrouterApiKey,
    hasOpenAI: !!cfg.openaiApiKey,
    hasAnthropic: !!cfg.anthropicApiKey,
    hasGemini: !!cfg.geminiApiKey,
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
