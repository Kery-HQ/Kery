import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import {
  runOrchestratedJob, enrichBugsForRun, generateRegressionPlan,
  createEmitter, getEmitter, destroyEmitter, requestStop, logger,
} from "@kery/engine";

const RunSchema = z.object({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  intent: z.string().min(3).optional(),
  testId: z.string().uuid().optional(),
  destinationId: z.string().uuid().optional(),
});

export function registerRunRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = (storage as any).pool as Pool;

  app.post("/api/projects/:projectId/run", async (req, reply) => {
    const projectId = (req.params as any).projectId;
    const body = req.body as any;
    const parsed = RunSchema.safeParse({ ...body, projectId });
    if (!parsed.success) { reply.code(400).send({ error: "invalid payload" }); return; }

    const { environmentId, testId, destinationId } = parsed.data;
    let intent = parsed.data.intent;
    let context: string | undefined;
    let saveScreenshots = false;
    let maxSteps: number | undefined;

    if (destinationId) {
      const dest = await storage.getDestination(destinationId);
      if (!dest) { reply.code(404).send({ error: "destination not found" }); return; }
      intent = intent || `Inspect ${dest.normalized_route} ("${dest.title}") for bugs`;
    }

    if (testId) {
      const savedTest = await storage.getSavedTest(testId);
      if (!savedTest) { reply.code(404).send({ error: "test not found" }); return; }
      intent = savedTest.intent;
      context = savedTest.context ?? undefined;
      saveScreenshots = savedTest.save_screenshots ?? false;
      maxSteps = savedTest.max_steps ?? undefined;
    }

    if (!intent) { reply.code(400).send({ error: "intent is required" }); return; }

    const { rows: [env] } = await pool.query("SELECT * FROM environments WHERE id = $1", [environmentId]);
    if (!env) { reply.code(404).send({ error: "environment not found" }); return; }

    const authRow = await storage.getAuthConfig(projectId, environmentId);

    const run = await storage.createTestRun({
      project_id: projectId, environment_id: environmentId,
      test_id: testId ?? null, destination_id: destinationId ?? null,
      trigger_type: "manual", trigger_ref: "dashboard",
      status: "running", started_at: new Date().toISOString(),
    });

    const emitter = createEmitter(run.id);
    reply.send({ runId: run.id, status: "running" });

    const authConfig = authRow ? { mode: authRow.mode, ...authRow.config_json } : null;

    setImmediate(async () => {
      try {
        const result = await runOrchestratedJob(storage, {
          runId: run.id, baseUrl: env.base_url, intent: intent!,
          projectId, auth: authConfig, testId, destinationId,
          context, saveScreenshots, maxSteps,
          onStep: (step) => emitter.emit("step", step),
          onScreenshot: (buf) => emitter.emit("screenshot", buf.toString("base64")),
          onLLMCall: (call) => emitter.emit("llm_call", call),
        });

        const completedAt = new Date().toISOString();
        const enrichedBugs = enrichBugsForRun(run.id, completedAt, run.trigger_ref, result.bugsFound, result.stepsDetail);

        await storage.updateTestRun(run.id, {
          status: result.status, summary: result.summary,
          steps_json: result.stepsDetail, bugs_json: enrichedBugs,
          llm_calls_json: result.llmCalls, completed_at: completedAt,
        });

        await storage.persistBugsFromRun(projectId, run.id, run.trigger_ref, completedAt, environmentId, env.name, enrichedBugs);

        if (destinationId) {
          await storage.upsertRunCoverage(run.id, destinationId, enrichedBugs.length);
          const healthData: any = { last_inspected_at: completedAt };
          if (enrichedBugs.length > 0) {
            healthData.health_status = "issues";
            healthData.issues_count = enrichedBugs.length;
          } else {
            healthData.health_status = "clean";
            healthData.issues_count = 0;
          }
          await storage.updateDestinationHealth(destinationId, healthData);

          if ((result.status === "passed" || result.status === "partial") && result.stepsDetail?.length > 0) {
            const regPlan = generateRegressionPlan(result.stepsDetail);
            if (regPlan.length > 0) {
              await storage.updateRegressionPlan("app_tree_destinations", destinationId, {
                regression_plan: regPlan, plan_status: "ready", plan_success_count: 1,
              });
            }
          }
        }

        if (testId && (result.status === "passed" || result.status === "partial") && result.stepsDetail?.length > 0) {
          const regPlan = generateRegressionPlan(result.stepsDetail);
          if (regPlan.length > 0) {
            await storage.updateSavedTest(testId, {
              regression_plan: regPlan, plan_status: "ready", plan_success_count: 1,
            });
          }
        }

        emitter.emit("done", { ...run, status: result.status, summary: result.summary });
      } catch (err) {
        logger.error({ runId: run.id, err: String(err) }, "Background run error");
        await storage.updateTestRun(run.id, {
          status: "failed", summary: String(err), completed_at: new Date().toISOString(),
        });
        emitter.emit("done", { ...run, status: "failed", summary: String(err) });
      } finally {
        destroyEmitter(run.id);
      }
    });
  });

  // SSE streaming
  app.get("/api/runs/:runId/stream", async (req, reply) => {
    const { runId } = req.params as any;
    reply.hijack();
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    const send = (payload: object) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      (reply.raw as any).flush?.();
    };

    const emitter = getEmitter(runId);
    if (!emitter) {
      const run = await storage.getTestRun(runId);
      if (!run) send({ type: "error", message: "run not found" });
      else send({ type: "done", run });
      reply.raw.end();
      return;
    }

    const heartbeat = setInterval(() => { reply.raw.write(`:keepalive\n\n`); }, 15_000);
    const onStep = (step: any) => send({ type: "step", step });
    const onScreenshot = (data: string) => send({ type: "screenshot", data });
    const onLLMCall = (call: any) => send({ type: "llm_call", call });
    const onDone = (run: any) => { clearInterval(heartbeat); send({ type: "done", run }); reply.raw.end(); };

    emitter.on("step", onStep);
    emitter.on("screenshot", onScreenshot);
    emitter.on("llm_call", onLLMCall);
    emitter.once("done", onDone);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      emitter.off("step", onStep);
      emitter.off("screenshot", onScreenshot);
      emitter.off("llm_call", onLLMCall);
      emitter.off("done", onDone);
    });
  });

  // Get single run
  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = req.params as any;
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    reply.send({ run });
  });

  // Stop a running run
  app.post("/api/runs/:runId/stop", async (req, reply) => {
    const { runId } = req.params as any;
    const run = await storage.getTestRun(runId);
    if (!run) { reply.code(404).send({ error: "run not found" }); return; }
    if (run.status !== "running") { reply.send({ ok: true, status: run.status }); return; }
    const stopped = requestStop(runId);
    if (!stopped) {
      // No active emitter — force-mark as failed directly
      await storage.updateTestRun(runId, {
        status: "failed", summary: "Stopped by user", completed_at: new Date().toISOString(),
      });
    }
    reply.send({ ok: true });
  });
}
