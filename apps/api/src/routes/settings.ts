import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StorageAdapter } from "@kery/engine";
import {
  updateEngineConfig,
  getConfig,
  getLlmKeyPresence,
  isModelRunnableWithConfig,
  type ModelConfigKey,
} from "@kery/engine";
import { encryptValue, decryptValue, maskedApiKey } from "@kery/db";
import { config as envConfig } from "../config.js";

// ─── API Key provider constants ────────────────────────────────────────────────

const API_KEY_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter"] as const;
type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

const PROVIDER_DB_KEY: Record<ApiKeyProvider, string> = {
  openai: "apiKey.openai",
  anthropic: "apiKey.anthropic",
  gemini: "apiKey.gemini",
  openrouter: "apiKey.openrouter",
};

const PROVIDER_ENV_KEY: Record<ApiKeyProvider, string> = {
  openai: envConfig.openaiApiKey,
  anthropic: envConfig.anthropicApiKey,
  gemini: envConfig.geminiApiKey,
  openrouter: envConfig.openrouterApiKey,
};

const PROVIDER_CONFIG_KEY: Record<ApiKeyProvider, "openaiApiKey" | "anthropicApiKey" | "geminiApiKey" | "openrouterApiKey"> = {
  openai: "openaiApiKey",
  anthropic: "anthropicApiKey",
  gemini: "geminiApiKey",
  openrouter: "openrouterApiKey",
};

/** Read DB API key overrides and merge into the running engine config (DB wins over .env). */
export async function applyDbApiKeySettings(storage: StorageAdapter): Promise<void> {
  try {
    const all = await storage.getSettings();
    const overrides: Partial<Record<"openaiApiKey" | "anthropicApiKey" | "geminiApiKey" | "openrouterApiKey", string>> = {};
    for (const provider of API_KEY_PROVIDERS) {
      const raw = all[PROVIDER_DB_KEY[provider]];
      if (raw) overrides[PROVIDER_CONFIG_KEY[provider]] = decryptValue(raw);
    }
    if (Object.keys(overrides).length > 0) updateEngineConfig(overrides);
  } catch {
    // settings table may not exist yet — skip silently
  }
}

/** The model keys we allow setting via the API. */
const MODEL_KEYS = [
  "agentModel",
  "auxiliaryModel",
  "reviewAgentModel",
  "stagehandModel",
] as const;

/** Pre-merge DB keys — still read for migration; deleted on reset. */
const LEGACY_MODEL_KEYS = ["summaryModel", "scriptModel", "reviewModel"] as const;

type ModelKey = (typeof MODEL_KEYS)[number];

const priceEntry = z.object({ input: z.number(), output: z.number() });

const ModelSettingsSchema = z.object({
  agentModel: z.string().optional(),
  auxiliaryModel: z.string().optional(),
  reviewAgentModel: z.string().optional(),
  stagehandModel: z.string().optional(),
  /** Per-slot custom $/1M token (USD). `null` clears stored pricing for that slot. */
  modelPrices: z
    .record(z.union([priceEntry, z.null()]))
    .optional(),
});

/** Read DB settings and merge into the running engine config. */
export async function applyDbModelSettings(storage: StorageAdapter): Promise<void> {
  try {
    const all = await storage.getSettings();
    const overrides: Record<string, string> = {};
    const prices: Partial<Record<ModelConfigKey, { input: number; output: number }>> = {};
    for (const key of MODEL_KEYS) {
      if (key === "auxiliaryModel") {
        const v =
          all["model.auxiliaryModel"] ??
          all["model.scriptModel"] ??
          all["model.summaryModel"] ??
          all["model.reviewModel"];
        if (v) overrides.auxiliaryModel = v;
        const priceRaw =
          all["modelPrice.auxiliaryModel"] ??
          all["modelPrice.scriptModel"] ??
          all["modelPrice.summaryModel"] ??
          all["modelPrice.reviewModel"];
        if (priceRaw) {
          try {
            const j = JSON.parse(priceRaw) as { input?: unknown; output?: unknown };
            if (typeof j.input === "number" && typeof j.output === "number") {
              prices.auxiliaryModel = { input: j.input, output: j.output };
            }
          } catch {
            /* skip */
          }
        }
        continue;
      }
      const dbKey = `model.${key}`;
      if (all[dbKey]) overrides[key] = all[dbKey];
      const pKey = `modelPrice.${key}`;
      if (all[pKey]) {
        try {
          const j = JSON.parse(all[pKey]) as { input?: unknown; output?: unknown };
          if (typeof j.input === "number" && typeof j.output === "number") {
            prices[key as ModelConfigKey] = { input: j.input, output: j.output };
          }
        } catch {
          /* skip bad JSON */
        }
      }
    }
    updateEngineConfig({
      ...(Object.keys(overrides).length > 0 ? overrides : {}),
      modelPriceUsdPerMillion: prices,
    });
  } catch {
    // settings table may not exist yet (migration not run) — skip silently
  }
}

const MAX_CONCURRENCY_DB_KEY = "platform.maxConcurrency";
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY_LIMIT = 10;

export async function applyDbPlatformSettings(storage: StorageAdapter): Promise<void> {
  // Currently a no-op for worker — concurrency is read directly from DB at startup
  // This hook exists so the API can notify other services of setting changes in future.
  void storage;
}

export function registerSettingsRoutes(app: FastifyInstance, storage: StorageAdapter) {
  /** GET /api/settings/platform — return platform-level settings */
  app.get("/api/settings/platform", async (_req, reply) => {
    let maxConcurrency = DEFAULT_CONCURRENCY;
    try {
      const all = await storage.getSettings();
      const raw = all[MAX_CONCURRENCY_DB_KEY];
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 1 && n <= MAX_CONCURRENCY_LIMIT) maxConcurrency = n;
      }
    } catch {}
    reply.send({ maxConcurrency, defaultConcurrency: DEFAULT_CONCURRENCY, maxConcurrencyLimit: MAX_CONCURRENCY_LIMIT });
  });

  /** PUT /api/settings/platform — save platform-level settings */
  app.put("/api/settings/platform", async (req, reply) => {
    const body = req.body as { maxConcurrency?: unknown };
    const n = typeof body?.maxConcurrency === "number" ? body.maxConcurrency : parseInt(String(body?.maxConcurrency), 10);
    if (!Number.isFinite(n) || n < 1 || n > MAX_CONCURRENCY_LIMIT) {
      reply.code(400).send({ error: "maxConcurrency must be between 1 and 10" });
      return;
    }
    await storage.saveSetting(MAX_CONCURRENCY_DB_KEY, String(Math.round(n)));
    reply.send({ ok: true });
  });


  /** GET /api/settings/models — return current model config + env defaults */
  app.get("/api/settings/models", async (_req, reply) => {
    const current = getConfig();
    const defaults: Record<ModelKey, string> = {
      agentModel: envConfig.agentModel,
      auxiliaryModel: envConfig.auxiliaryModel,
      reviewAgentModel: envConfig.reviewAgentModel,
      stagehandModel: envConfig.stagehandModel,
    };

    let dbOverrides: Record<string, string> = {};
    try {
      const all = await storage.getSettings();
      for (const key of MODEL_KEYS) {
        if (key === "auxiliaryModel") {
          const v =
            all["model.auxiliaryModel"] ??
            all["model.scriptModel"] ??
            all["model.summaryModel"] ??
            all["model.reviewModel"];
          if (v) dbOverrides.auxiliaryModel = v;
          continue;
        }
        const dbKey = `model.${key}`;
        if (all[dbKey]) dbOverrides[key] = all[dbKey];
      }
    } catch {}

    const models: Record<string, { current: string; default: string; customized: boolean }> = {};
    for (const key of MODEL_KEYS) {
      models[key] = {
        current: current[key],
        default: defaults[key],
        customized: !!dbOverrides[key],
      };
    }

    const mp = getConfig().modelPriceUsdPerMillion ?? {};
    const modelPrices: Partial<Record<ModelKey, { input: number; output: number }>> = {};
    for (const key of MODEL_KEYS) {
      const v = mp[key as ModelConfigKey];
      if (v) modelPrices[key] = v;
    }

    reply.send({ models, llmKeys: getLlmKeyPresence(getConfig()), modelPrices });
  });

  /** PUT /api/settings/models — save model overrides */
  app.put("/api/settings/models", async (req, reply) => {
    const parsed = ModelSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload" });
      return;
    }

    const overrides: Partial<Record<ModelKey, string>> = {};

    for (const key of MODEL_KEYS) {
      const value = parsed.data[key];
      if (value !== undefined) {
        const dbKey = `model.${key}`;
        if (value === "") {
          const keysToDelete =
            key === "auxiliaryModel"
              ? [
                  "model.auxiliaryModel",
                  "model.scriptModel",
                  "model.summaryModel",
                  "model.reviewModel",
                ]
              : [dbKey];
          await storage.deleteSettings(keysToDelete);
        } else {
          if (!isModelRunnableWithConfig(value, getConfig())) {
            reply.code(400).send({ error: "model_unavailable", message: `No API key configured for model "${value}".` });
            return;
          }
          await storage.saveSetting(dbKey, value);
          overrides[key] = value;
          if (key === "auxiliaryModel") {
            await storage.deleteSettings([
              "model.scriptModel",
              "model.summaryModel",
              "model.reviewModel",
            ]);
          }
        }
      }
    }

    const rawPrices = parsed.data.modelPrices;
    if (rawPrices) {
      for (const k of Object.keys(rawPrices)) {
        if (!MODEL_KEYS.includes(k as ModelKey)) continue;
        const dbPriceKey = `modelPrice.${k}`;
        const v = rawPrices[k];
        if (v === null) {
          const priceKeysToDelete =
            k === "auxiliaryModel"
              ? [
                  "modelPrice.auxiliaryModel",
                  "modelPrice.scriptModel",
                  "modelPrice.summaryModel",
                  "modelPrice.reviewModel",
                ]
              : [dbPriceKey];
          await storage.deleteSettings(priceKeysToDelete);
        } else if (v && typeof v.input === "number" && typeof v.output === "number") {
          if (v.input < 0 || v.output < 0) {
            reply.code(400).send({ error: "invalid_price", message: "Model prices must be non-negative numbers." });
            return;
          }
          await storage.saveSetting(dbPriceKey, JSON.stringify({ input: v.input, output: v.output }));
          if (k === "auxiliaryModel") {
            await storage.deleteSettings([
              "modelPrice.scriptModel",
              "modelPrice.summaryModel",
              "modelPrice.reviewModel",
            ]);
          }
        }
      }
    }

    // Re-apply all DB settings to get the correct merged state
    await applyDbModelSettings(storage);

    reply.send({ ok: true });
  });

  /** DELETE /api/settings/models — reset all model settings to env defaults */
  app.delete("/api/settings/models", async (_req, reply) => {
    const dbKeys = MODEL_KEYS.map((k) => `model.${k}`);
    const priceKeys = MODEL_KEYS.map((k) => `modelPrice.${k}`);
    const legacyDbKeys = LEGACY_MODEL_KEYS.flatMap((k) => [`model.${k}`, `modelPrice.${k}`]);
    await storage.deleteSettings([...dbKeys, ...priceKeys, ...legacyDbKeys]);

    // Re-init from env defaults
    updateEngineConfig({
      agentModel: envConfig.agentModel,
      auxiliaryModel: envConfig.auxiliaryModel,
      reviewAgentModel: envConfig.reviewAgentModel,
      stagehandModel: envConfig.stagehandModel,
      modelPriceUsdPerMillion: {},
    });

    reply.send({ ok: true });
  });

  // ─── API Key routes ──────────────────────────────────────────────────────────

  /**
   * GET /api/settings/api-keys
   * Returns which API keys are configured and their source (env / db / none).
   * Never returns the actual key values — only booleans and masked hints.
   */
  app.get("/api/settings/api-keys", async (_req, reply) => {
    let dbKeys: Record<string, string> = {};
    try {
      dbKeys = await storage.getSettings();
    } catch {}

    const result: Record<ApiKeyProvider, { hasKey: boolean; source: "env" | "db" | "none"; maskedKey?: string }> = {} as any;
    for (const provider of API_KEY_PROVIDERS) {
      const dbRaw = dbKeys[PROVIDER_DB_KEY[provider]];
      if (dbRaw) {
        const plain = decryptValue(dbRaw);
        result[provider] = { hasKey: true, source: "db", maskedKey: maskedApiKey(plain) };
      } else if (PROVIDER_ENV_KEY[provider]) {
        result[provider] = { hasKey: true, source: "env" };
      } else {
        result[provider] = { hasKey: false, source: "none" };
      }
    }

    reply.send(result);
  });

  const SaveApiKeysSchema = z.object({
    openai: z.string().optional(),
    anthropic: z.string().optional(),
    gemini: z.string().optional(),
    openrouter: z.string().optional(),
  });

  /**
   * PUT /api/settings/api-keys
   * Save one or more API keys to the DB. DB keys take precedence over .env values.
   * Empty string clears the DB override for that provider.
   */
  app.put("/api/settings/api-keys", async (req, reply) => {
    const parsed = SaveApiKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid payload" });
      return;
    }

    for (const provider of API_KEY_PROVIDERS) {
      const value = parsed.data[provider];
      if (value === undefined) continue;
      const dbKey = PROVIDER_DB_KEY[provider];
      if (value.trim() === "") {
        await storage.deleteSettings([dbKey]);
      } else {
        await storage.saveSetting(dbKey, encryptValue(value.trim()));
      }
    }

    // Re-apply all DB API key settings so in-memory config reflects the change
    await applyDbApiKeySettings(storage);

    reply.send({ ok: true });
  });

  /**
   * DELETE /api/settings/api-keys/:provider
   * Remove a provider's DB key override (falls back to .env value).
   */
  app.delete("/api/settings/api-keys/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!API_KEY_PROVIDERS.includes(provider as ApiKeyProvider)) {
      reply.code(400).send({ error: "unknown provider" });
      return;
    }
    await storage.deleteSettings([PROVIDER_DB_KEY[provider as ApiKeyProvider]]);

    // Revert in-memory config to env value for this provider
    const envValue = PROVIDER_ENV_KEY[provider as ApiKeyProvider];
    updateEngineConfig({ [PROVIDER_CONFIG_KEY[provider as ApiKeyProvider]]: envValue });

    reply.send({ ok: true });
  });
}
