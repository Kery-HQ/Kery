import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeryClient } from "@keryai/client";

export function registerSettingsTools(server: McpServer, client: KeryClient) {
  server.tool(
    "kery_get_settings",
    `Get the current LLM model configuration and API key status for Kery.

WHEN TO USE:
  • User asks "what model is kery using", "which API keys are configured", "show kery settings"
  • Before changing settings to see the current state
  • Diagnosing why tests aren't running (may be missing API keys)

Returns:
  • Model slots (agentModel, auxiliaryModel, reviewAgentModel, stagehandModel) — current values and whether they are customized
  • API key status for each provider (openai, anthropic, gemini, openrouter) — whether a key is set and its source (env var or DB override). Key values are never returned, only a masked hint.
  • Whether each model can run with the current key configuration`,
    {},
    async () => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      const settings = await client.getModelSettings();
      const apiKeys = await client.getApiKeys();

      const missingKeys = Object.entries(apiKeys)
        .filter(([, v]) => !(v as any).hasKey)
        .map(([k]) => k);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            models: settings.models,
            modelPrices: settings.modelPrices ?? {},
            apiKeys,
            nextSteps: [
              missingKeys.length > 0
                ? `No API key configured for: ${missingKeys.join(", ")}. Call kery_update_settings to add keys. At least one LLM provider key is required.`
                : "All required API keys are configured.",
              "To change a model, call kery_update_settings with the model slot and new model name.",
            ],
            tip: "Kery uses OpenRouter by default (routes to all models). Set OPENROUTER_API_KEY for the broadest model support.",
          }),
        }],
      };
    },
  );

  server.tool(
    "kery_update_settings",
    `Update Kery's LLM model configuration or API keys.

WHEN TO USE:
  • User says "change the model", "use gpt-4o instead", "add my OpenAI key", "switch to Claude"
  • Configuring API keys for the first time
  • Rotating API keys
  • Customizing which models Kery uses for different tasks

MODEL SLOTS:
  'agentModel'       — makes browser automation decisions. Default: openai/gpt-4.1-mini
  'auxiliaryModel'   — test plans, summaries, memory curation. Default: gemini-2.5-flash
  'reviewAgentModel' — post-run holistic screenshot analysis. Default: gemini-2.5-flash
  'stagehandModel'   — element finding when selectors break. Default: gpt-4o-mini

API KEY PROVIDERS (at least one required):
  'openrouter'  — routes to all models (recommended; set OPENROUTER_API_KEY)
  'openai'      — direct OpenAI access
  'anthropic'   — direct Anthropic access
  'gemini'      — direct Google Gemini access

VALIDATION:
  • Model names must be valid for an available provider (e.g. 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet', 'gemini-2.5-flash')
  • Passing empty string ('') for a model resets it to the default
  • API key values are encrypted at rest; pass empty string to clear a DB override (reverts to env var)`,
    {
      models: z
        .object({
          agentModel: z
            .string()
            .optional()
            .describe(
              "Browser automation model (e.g. 'openai/gpt-4o', 'openai/gpt-4.1-mini'). " +
              "Empty string resets to default.",
            ),
          auxiliaryModel: z
            .string()
            .optional()
            .describe(
              "Crawl + planning model (e.g. 'gemini-2.5-flash', 'openai/gpt-4o-mini'). " +
              "Empty string resets to default.",
            ),
          reviewAgentModel: z
            .string()
            .optional()
            .describe(
              "Screenshot analysis model (e.g. 'gemini-2.5-flash', 'anthropic/claude-3-5-sonnet'). " +
              "Empty string resets to default.",
            ),
          stagehandModel: z
            .string()
            .optional()
            .describe(
              "Element-finding model (e.g. 'gpt-4o-mini', 'openai/gpt-4o'). " +
              "Empty string resets to default.",
            ),
        })
        .optional()
        .describe("Model overrides — provide only the slots you want to change"),
      apiKeys: z
        .object({
          openai: z
            .string()
            .optional()
            .describe("OpenAI API key (starts with 'sk-'). Pass empty string to clear the DB override."),
          anthropic: z
            .string()
            .optional()
            .describe("Anthropic API key (starts with 'sk-ant-'). Pass empty string to clear."),
          gemini: z
            .string()
            .optional()
            .describe("Google Gemini API key. Pass empty string to clear."),
          openrouter: z
            .string()
            .optional()
            .describe("OpenRouter API key (starts with 'sk-or-'). Pass empty string to clear."),
        })
        .optional()
        .describe("API keys to save. Values are encrypted at rest and never returned in API responses."),
    },
    async ({ models, apiKeys }) => {
      const healthy = await client.checkHealth();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Kery is not running. Call kery_start first." }],
          isError: true,
        };
      }

      if (!models && !apiKeys) {
        return {
          content: [{
            type: "text",
            text: "Provide at least one of 'models' or 'apiKeys' to update. Call kery_get_settings first to see current values.",
          }],
          isError: true,
        };
      }

      const errors: string[] = [];

      if (models && Object.keys(models).length > 0) {
        const result = await client.updateModelSettings(models).catch((e: Error) => {
          errors.push(`Model update failed: ${e.message}`);
          return null;
        });
        if (!result && errors.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: errors[0],
                tip: "The model name may not be available with your current API keys. Check kery_get_settings for which providers have keys configured.",
              }),
            }],
            isError: true,
          };
        }
      }

      if (apiKeys && Object.keys(apiKeys).length > 0) {
        await client.updateApiKeys(apiKeys).catch((e: Error) => {
          errors.push(`API key update failed: ${e.message}`);
        });
      }

      if (errors.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ partialSuccess: true, errors }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated: true,
            changedModels: models ? Object.keys(models) : [],
            changedApiKeys: apiKeys ? Object.keys(apiKeys).map((k) => `${k} (value hidden)`) : [],
            nextSteps: [
              "Settings saved. Call kery_get_settings to verify.",
              "Changes take effect immediately — the next test run will use the new models.",
            ],
          }),
        }],
      };
    },
  );
}
