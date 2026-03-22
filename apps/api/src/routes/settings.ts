import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StorageAdapter } from "@kery/engine";
import { updateEngineConfig, getConfig } from "@kery/engine";
import { config as envConfig } from "../config.js";

/** The model keys we allow setting via the API. */
const MODEL_KEYS = [
  "agentModel",
  "summaryModel",
  "reviewModel",
  "reviewAgentModel",
  "scriptModel",
  "stagehandModel",
] as const;

type ModelKey = (typeof MODEL_KEYS)[number];

const ModelSettingsSchema = z.object({
  agentModel: z.string().optional(),
  summaryModel: z.string().optional(),
  reviewModel: z.string().optional(),
  reviewAgentModel: z.string().optional(),
  scriptModel: z.string().optional(),
  stagehandModel: z.string().optional(),
});

/** Read DB settings and merge into the running engine config. */
export async function applyDbModelSettings(storage: StorageAdapter): Promise<void> {
  try {
    const all = await storage.getSettings();
    const overrides: Record<string, string> = {};
    for (const key of MODEL_KEYS) {
      const dbKey = `model.${key}`;
      if (all[dbKey]) overrides[key] = all[dbKey];
    }
    if (Object.keys(overrides).length > 0) {
      updateEngineConfig(overrides);
    }
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
      summaryModel: envConfig.summaryModel,
      reviewModel: envConfig.reviewModel,
      reviewAgentModel: envConfig.reviewAgentModel,
      scriptModel: envConfig.scriptModel,
      stagehandModel: envConfig.stagehandModel,
    };

    let dbOverrides: Record<string, string> = {};
    try {
      const all = await storage.getSettings();
      for (const key of MODEL_KEYS) {
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

    reply.send({ models });
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
          // Empty string = reset to default
          await storage.deleteSettings([dbKey]);
        } else {
          await storage.saveSetting(dbKey, value);
          overrides[key] = value;
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
    await storage.deleteSettings(dbKeys);

    // Re-init from env defaults
    updateEngineConfig({
      agentModel: envConfig.agentModel,
      summaryModel: envConfig.summaryModel,
      reviewModel: envConfig.reviewModel,
      reviewAgentModel: envConfig.reviewAgentModel,
      scriptModel: envConfig.scriptModel,
      stagehandModel: envConfig.stagehandModel,
    });

    reply.send({ ok: true });
  });
}
