import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferModelProviderRequirement,
  isModelRunnableWithConfig,
  modelUnavailableReason,
  getLlmKeyPresence,
  hasCustomEndpoint,
  wireModelForCustomEndpoint,
  CUSTOM_MODEL_PREFIX,
} from "../llmProviders.js";
import type { EngineConfig } from "../config.js";

const baseConfig = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  openaiApiKey: "",
  openrouterApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  agentModel: "anthropic/claude-sonnet-5",
  auxiliaryModel: "anthropic/claude-haiku-4.5",
  reviewAgentModel: "anthropic/claude-sonnet-5",
  stagehandEnabled: false,
  stagehandModel: "anthropic/claude-haiku-4.5",
  runTimeoutMinutes: 15,
  llmTimeoutMs: 45000,
  reviewTimeoutMs: 30000,
  ...overrides,
});

test("custom/ prefix classifies as the custom provider", () => {
  assert.deepEqual(inferModelProviderRequirement("custom/qwen3-coder-plus"), { kind: "custom" });
  assert.deepEqual(inferModelProviderRequirement(`${CUSTOM_MODEL_PREFIX}gpt-4o`), { kind: "custom" });
});

test("custom/ models run only when a custom endpoint is configured", () => {
  const withEndpoint = baseConfig({ customLlmBaseUrl: "https://example.com/v1" });
  const withoutEndpoint = baseConfig({ openrouterApiKey: "sk-or-xxx" });
  assert.equal(isModelRunnableWithConfig("custom/qwen3-coder-plus", withEndpoint), true);
  // OpenRouter cannot serve an explicitly custom-routed model.
  assert.equal(isModelRunnableWithConfig("custom/qwen3-coder-plus", withoutEndpoint), false);
  assert.match(modelUnavailableReason("custom/qwen3-coder-plus", withoutEndpoint) ?? "", /CUSTOM_LLM_BASE_URL/);
});

test("a custom endpoint acts as catch-all fallback for otherwise unrunnable models", () => {
  const cfg = baseConfig({ customLlmBaseUrl: "https://example.com/v1" });
  assert.equal(isModelRunnableWithConfig("qwen3-max", cfg), true);
  assert.equal(isModelRunnableWithConfig("openai/gpt-4o", cfg), true);
  assert.equal(isModelRunnableWithConfig("anthropic/claude-sonnet-5", cfg), true);
});

test("no keys and no endpoint means nothing is runnable", () => {
  const cfg = baseConfig();
  assert.equal(isModelRunnableWithConfig("qwen3-max", cfg), false);
  assert.equal(isModelRunnableWithConfig("openai/gpt-4o", cfg), false);
});

test("endpoint presence does not require an API key", () => {
  assert.equal(hasCustomEndpoint(baseConfig({ customLlmBaseUrl: "http://localhost:11434/v1" })), true);
  assert.equal(hasCustomEndpoint(baseConfig({ customLlmApiKey: "sk-xxx" })), false);
});

test("key presence includes hasCustom", () => {
  const presence = getLlmKeyPresence(baseConfig({ customLlmBaseUrl: "https://example.com/v1" }));
  assert.equal(presence.hasCustom, true);
  assert.equal(getLlmKeyPresence(baseConfig()).hasCustom, false);
});

test("wire model strips only the custom/ routing prefix", () => {
  assert.equal(wireModelForCustomEndpoint("custom/qwen3-coder-plus"), "qwen3-coder-plus");
  assert.equal(wireModelForCustomEndpoint("qwen3-max"), "qwen3-max");
  assert.equal(wireModelForCustomEndpoint("openai/gpt-4o"), "openai/gpt-4o");
});
