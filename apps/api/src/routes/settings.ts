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
import { config as envConfig } from "../config.js";

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
          all["model.crawlModel"] ??
          all["model.scriptModel"] ??
          all["model.summaryModel"] ??
          all["model.reviewModel"];
        if (v) overrides.auxiliaryModel = v;
        const priceRaw =
          all["modelPrice.auxiliaryModel"] ??
          all["modelPrice.crawlModel"] ??
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

export function registerSettingsRoutes(app: FastifyInstance, storage: StorageAdapter) {
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
            all["model.crawlModel"] ??
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
          // Empty string = reset to default (crawl merge: clear legacy keys too)
          const keysToDelete =
            key === "auxiliaryModel"
              ? [
                  "model.auxiliaryModel",
                  "model.crawlModel",
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
              "model.crawlModel",
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
                  "modelPrice.crawlModel",
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
              "modelPrice.crawlModel",
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
    const legacyCrawlRename = ["model.crawlModel", "modelPrice.crawlModel"] as const;
    await storage.deleteSettings([...dbKeys, ...priceKeys, ...legacyDbKeys, ...legacyCrawlRename]);

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
}
