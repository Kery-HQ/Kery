#!/usr/bin/env node
/**
 * Local benchmark harness.
 *
 * Runs the REAL engine (same runOrchestratedJob the cloud worker calls) against
 * a locally served app, using an in-memory storage adapter. Scores the result
 * against a suite file that declares each case's planted bugs and how to detect
 * them, then writes a JSON result so runs are comparable over time.
 *
 *   node harness/run-benchmark.mjs --suite ../../harness-suite.json          # all cases
 *   node harness/run-benchmark.mjs --suite ... --case quote-builder          # one case
 *   node harness/run-benchmark.mjs --suite ... --repeat 3                    # variance
 *
 * Requires OPENAI_API_KEY. Everything else is local.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStorage } from "./memoryStorage.mjs";
import { judgeCase } from "./judge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { initEngineConfig, runOrchestratedJob } = await import(path.join(here, "../dist/index.js"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const suitePath = path.resolve(arg("suite", path.join(here, "../../../harness-suite.json")));
const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
const only = arg("case");
const repeat = Number(arg("repeat", "1"));
const outDir = path.resolve(arg("out", path.join(here, "../../../harness-results")));
/**
 * "review" mode is the honest one: it runs the SAME review pass the cloud CI
 * uses to turn a diff into a test plan, so improvements to that prompt are
 * measured here. "scripted" mode uses the suite's hand-written intent and acts
 * as the ceiling — what the agent achieves when the plan is already perfect.
 */
const mode = arg("mode", "scripted");
/**
 * Sharding for parallel runs. Each shard drives its OWN copy of the apps on a
 * distinct port block, because two runs against one app server corrupted results
 * earlier: shared page state leaked between them.
 *   --shard 0/4      take every 4th case starting at 0
 *   --portOffset 10  add 10 to every case port (that shard's own servers)
 */
const shardArg = arg("shard", null);
const portOffset = Number(arg("portOffset", "0"));
/**
 * "review" mode needs the cloud worker's compiled review pass, which lives in a
 * separate repo. Point KERY_PR_REVIEW_PATH at its built prReview.js; without it
 * only "scripted" mode (the ceiling) can run.
 */
const PR_REVIEW_PATH = process.env.KERY_PR_REVIEW_PATH ?? "";
fs.mkdirSync(outDir, { recursive: true });

const MODELS = {
  agentModel: process.env.KERY_AGENT_MODEL || "openai/gpt-5.6-terra",
  auxiliaryModel: process.env.KERY_AUXILIARY_MODEL || "openai/gpt-5.6-luna",
  reviewAgentModel: process.env.KERY_REVIEW_MODEL || "openai/gpt-5.6-terra",
  stagehandModel: process.env.KERY_STAGEHAND_MODEL || "openai/gpt-5.6-luna",
};

initEngineConfig({
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  anthropicApiKey: "",
  geminiApiKey: "",
  ...MODELS,
  stagehandEnabled: false,
  runTimeoutMinutes: Number(process.env.KERY_RUN_TIMEOUT_MIN || 12),
  llmTimeoutMs: 120_000,
  reviewTimeoutMs: 120_000,
});

/** A planted bug counts as caught if any of its regexes matches a finding or a contradicted check. */
function scoreCase(testCase, result) {
  const haystacks = [
    ...(result.bugsFound ?? []).map((b) => `${b.reasoning ?? ""} ${b.bugDescription ?? ""}`),
    ...(result.verifications ?? [])
      .filter((v) => v.status === "contradicted")
      .map((v) => `${v.claim} ${v.evidence}`),
  ].map((s) => s.toLowerCase());

  return testCase.plantedBugs.map((bug) => {
    const patterns = bug.detect.map((p) => new RegExp(p, "i"));
    const hit = haystacks.find((h) => patterns.every((re) => re.test(h)));
    return { id: bug.id, class: bug.class, caught: Boolean(hit), evidence: hit ? hit.slice(0, 220) : null };
  });
}

/** Parse a unified diff into the {filename, patch, additions, deletions} shape the review pass expects. */
function parseDiff(patchText) {
  const files = [];
  for (const chunk of patchText.split(/^diff --git /m).slice(1)) {
    const nameMatch = chunk.match(/^a\/(\S+) b\/(\S+)/);
    if (!nameMatch) continue;
    const body = chunk.slice(chunk.indexOf("@@") >= 0 ? chunk.indexOf("@@") : 0);
    files.push({
      filename: nameMatch[2],
      patch: body.slice(0, 12_000),
      additions: (body.match(/^\+/gm) ?? []).length,
      deletions: (body.match(/^-/gm) ?? []).length,
    });
  }
  return files;
}

async function intentForCase(testCase) {
  if (mode !== "review") return { intent: testCase.intent, context: testCase.context ?? "", plan: null };
  if (!testCase.diffFile) throw new Error(`case ${testCase.id} has no diffFile for review mode`);
  if (!PR_REVIEW_PATH) throw new Error("review mode needs KERY_PR_REVIEW_PATH set to the worker's built prReview.js");
  const { reviewPullRequest, intentWithPlan } = await import(PR_REVIEW_PATH);
  const files = parseDiff(fs.readFileSync(testCase.diffFile, "utf8"));
  const review = await reviewPullRequest(
    { number: 1, title: testCase.prTitle ?? testCase.id, body: testCase.prBody ?? "", headSha: "local", branch: "bench" },
    files,
    { reachability: [], conventions: [] },
  );
  return {
    intent: intentWithPlan(review),
    context: review.context,
    plan: review.testPlan,
    codeFindings: review.codeFindings,
    skipBrowser: review.skipBrowser,
  };
}

async function runCase(testCase, attempt) {
  const storage = createMemoryStorage();
  const runId = `${testCase.id}-${attempt}-${Date.now()}`;
  const started = Date.now();
  let result;
  let planned;
  try {
    planned = await intentForCase(testCase);
    result = await runOrchestratedJob(storage, {
      runId,
      baseUrl: testCase.baseUrl,
      intent: planned.intent,
      context: planned.context ?? "",
      projectId: `harness-${testCase.id}`,
      auth: testCase.auth ?? null,
      saveScreenshots: false,
      recordVideo: false,
      maxSteps: testCase.maxSteps ?? 40,
    });
  } catch (err) {
    return {
      case: testCase.id, attempt, error: String(err).slice(0, 400),
      durationMs: Date.now() - started, scored: [], checks: 0, contradicted: 0, findings: 0, costUsd: 0,
    };
  }

  const costUsd = (result.llmCalls ?? []).reduce((s, c) => s + (c.costUsd ?? 0), 0);
  // Semantic judging: regex matching produced false negatives (the run said
  // "remains", the pattern wanted "unchanged") which silently distorted every
  // comparison between iterations.
  let scored;
  try {
    scored = await judgeCase(testCase, result, process.env.OPENAI_API_KEY);
  } catch (err) {
    console.warn(`  judge failed, falling back to regex: ${String(err).slice(0, 120)}`);
    scored = scoreCase(testCase, result);
  }
  return {
    case: testCase.id,
    attempt,
    durationMs: Date.now() - started,
    status: result.status,
    steps: (result.stepsDetail ?? []).length,
    findings: (result.bugsFound ?? []).length,
    checks: (result.verifications ?? []).length,
    contradicted: (result.verifications ?? []).filter((v) => v.status === "contradicted").length,
    costUsd: Number(costUsd.toFixed(4)),
    caught: scored.filter((s) => s.caught).length,
    planted: scored.length,
    scored,
    verifications: result.verifications ?? [],
    findingTexts: (result.bugsFound ?? []).map((b) => (b.reasoning ?? b.bugDescription ?? "").slice(0, 200)),
    mode,
    plan: planned?.plan ?? null,
    codeFindings: planned?.codeFindings ?? null,
    intentUsed: planned?.intent?.slice(0, 1500) ?? null,
  };
}

let cases = suite.cases.filter((c) => (only ? c.id === only : true) && !c.disabled);
if (shardArg) {
  const [idx, total] = shardArg.split("/").map(Number);
  cases = cases.filter((_, i) => i % total === idx);
}
if (portOffset) {
  cases = cases.map((c) => ({
    ...c,
    port: c.port + portOffset,
    baseUrl: c.baseUrl.replace(/:(\d+)/, (_, p) => `:${Number(p) + portOffset}`),
  }));
}
if (cases.length === 0) {
  console.error(`No cases matched (suite has ${suite.cases.length}).`);
  process.exit(1);
}

const results = [];
for (const testCase of cases) {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    process.stdout.write(`▶ ${testCase.id} (attempt ${attempt}/${repeat}) … `);
    const r = await runCase(testCase, attempt);
    results.push(r);
    // Held-out cases exist to catch overfitting, which only works if the person
    // tuning the prompt cannot see WHICH bugs they miss. Scores are still
    // written to the result file; the per-bug breakdown stays hidden until
    // --reveal, so iteration cannot quietly target this case.
    const hidden = testCase.heldOut && !flag("reveal");
    const label = r.error
      ? `ERROR ${r.error.slice(0, 80)}`
      : hidden
        ? `[held-out — score hidden] · ${r.checks} checks · $${r.costUsd} · ${Math.round(r.durationMs / 1000)}s`
        : `${r.caught}/${r.planted} caught · ${r.checks} checks · $${r.costUsd} · ${Math.round(r.durationMs / 1000)}s`;
    console.log(label);
    if (!flag("quiet") && r.scored && !hidden) {
      for (const s of r.scored) console.log(`    ${s.caught ? "✅" : "❌"} ${s.id} (${s.class})`);
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `${arg("label", "run")}-${stamp}.json`);
const heldOutIds = new Set(suite.cases.filter((c) => c.heldOut).map((c) => c.id));
const tuning = results.filter((r) => !heldOutIds.has(r.case));
const totals = {
  caught: tuning.reduce((s, r) => s + (r.caught ?? 0), 0),
  planted: tuning.reduce((s, r) => s + (r.planted ?? 0), 0),
  heldOut: {
    caught: results.filter((r) => heldOutIds.has(r.case)).reduce((s, r) => s + (r.caught ?? 0), 0),
    planted: results.filter((r) => heldOutIds.has(r.case)).reduce((s, r) => s + (r.planted ?? 0), 0),
  },
  costUsd: Number(results.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
  errors: results.filter((r) => r.error).length,
};
fs.writeFileSync(outFile, JSON.stringify({ label: arg("label", "run"), mode, models: MODELS, totals, results }, null, 2));

console.log(`\n── TUNING SET ${totals.caught}/${totals.planted} planted bugs caught · $${totals.costUsd} · ${totals.errors} errors`);
if (totals.heldOut.planted > 0) {
  console.log(`   held-out: ${flag("reveal") ? `${totals.heldOut.caught}/${totals.heldOut.planted}` : `${totals.heldOut.planted} bugs, score hidden (rerun with --reveal)`}`);
}
console.log(`   ${outFile}`);
