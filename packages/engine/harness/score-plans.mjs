#!/usr/bin/env node
/**
 * Score PLAN quality directly, without running a browser.
 *
 * Why this exists: seven prompt iterations produced totals between 44% and 56%
 * with no detectable trend, because each end-to-end run costs ~5 minutes and
 * ~$0.50 and layers browser-execution variance on top of the thing being
 * changed. The same config on the same case scored 1/3 and then 2/3. At n=18
 * a one-bug difference is unmeasurable, so every conclusion was noise.
 *
 * The plan is what the prompt controls, so measure the plan. One cheap LLM call
 * per (plan, bug) asks whether executing that plan would EXPOSE that defect.
 * That is ~100x cheaper and faster than a browser run, which buys enough
 * repeats to tell a real change from noise.
 *
 * This is a proxy, and worth stating plainly: a good plan can still fail if the
 * agent executes it badly. It is a fair proxy here because the scripted ceiling
 * scores 94% end-to-end using hand-written plans — execution is not the binding
 * constraint, plan generation is.
 *
 *   KERY_PR_REVIEW_PATH=... node harness/score-plans.mjs --repeat 5
 *   KERY_PR_REVIEW_PATH=... node harness/score-plans.mjs --repeat 5 --label v7
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const suite = JSON.parse(fs.readFileSync(path.join(here, "suite.json"), "utf8"));
const apiKey = process.env.OPENAI_API_KEY;
const reviewPath = process.env.KERY_PR_REVIEW_PATH;
if (!apiKey) { console.error("OPENAI_API_KEY required"); process.exit(1); }
if (!reviewPath) { console.error("KERY_PR_REVIEW_PATH required"); process.exit(1); }
const { reviewPullRequest, intentWithPlan } = await import(reviewPath);

const repeat = Number(arg("repeat", "3"));
const label = arg("label", "plans");
const JUDGE_MODEL = process.env.KERY_JUDGE_MODEL || "terra";

const SYSTEM = `You decide whether a browser test plan would EXPOSE a specific known defect.

You get the defect (what is broken and the symptom a user would see) and a test plan.

Answer yes only if some check in the plan would make that defect VISIBLE when executed:
- the plan must reach the affected control AND use inputs for which correct and buggy behaviour differ, AND state an expectation precise enough to fail.
- a check that visits the area with default or obviously-invalid inputs does NOT expose it, because correct and broken code behave the same way there.
- a check that would surface the wrong behaviour but describes the expectation only vaguely ("should work correctly") does NOT count.
- you are judging the PLAN as written, not what a clever agent might improvise.

Be strict and consistent. Return JSON only:
{"results":[{"id": string, "exposed": boolean, "why": string}]}`;

function parseDiff(patchText) {
  const files = [];
  for (const chunk of patchText.split(/^diff --git /m).slice(1)) {
    const m = chunk.match(/^a\/(\S+) b\/(\S+)/);
    if (!m) continue;
    const body = chunk.slice(chunk.indexOf("@@") >= 0 ? chunk.indexOf("@@") : 0);
    files.push({ filename: m[2], patch: body.slice(0, 12_000), additions: 0, deletions: 0 });
  }
  return files;
}

async function judgePlan(testCase, planText) {
  const user = [
    "PLANTED DEFECTS:",
    ...testCase.plantedBugs.map((b) => `- id: ${b.id}\n  broken: ${b.note}\n  user-visible symptom: ${b.symptom}`),
    "",
    "TEST PLAN:",
    planText,
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      max_completion_tokens: 2_000,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const body = await res.json();
  const parsed = JSON.parse((body.choices?.[0]?.message?.content ?? "{}").replace(/^```(?:json)?|```$/g, ""));
  const byId = new Map((parsed.results ?? []).map((r) => [r.id, r]));
  return testCase.plantedBugs.map((b) => ({ id: b.id, exposed: Boolean(byId.get(b.id)?.exposed) }));
}

const cases = suite.cases.filter((c) => !c.disabled);
const tally = new Map(); // bugId -> {hit, of}
let heldOutHit = 0;
let heldOutOf = 0;

for (const testCase of cases) {
  const files = parseDiff(fs.readFileSync(testCase.diffFile, "utf8"));
  for (let attempt = 1; attempt <= repeat; attempt++) {
    let scored;
    try {
      const review = await reviewPullRequest(
        { number: 1, title: testCase.prTitle, body: testCase.prBody, headSha: "local", branch: "bench" },
        files,
        { reachability: [], conventions: [] },
      );
      scored = await judgePlan(testCase, intentWithPlan(review));
    } catch (err) {
      console.warn(`  ${testCase.id} attempt ${attempt} failed: ${String(err).slice(0, 120)}`);
      continue;
    }
    for (const s of scored) {
      if (testCase.heldOut) { heldOutOf++; if (s.exposed) heldOutHit++; continue; }
      const prev = tally.get(s.id) ?? { hit: 0, of: 0 };
      tally.set(s.id, { hit: prev.hit + (s.exposed ? 1 : 0), of: prev.of + 1 });
    }
    const shown = testCase.heldOut && !flag("reveal")
      ? "[held-out — hidden]"
      : `${scored.filter((s) => s.exposed).length}/${scored.length}`;
    process.stdout.write(`  ${testCase.id} ${attempt}/${repeat}: ${shown}\n`);
  }
}

let hit = 0;
let of = 0;
console.log(`\nPLAN EXPOSURE — ${label} (n=${repeat} plans per case)`);
for (const [bug, v] of [...tally].sort()) {
  hit += v.hit;
  of += v.of;
  console.log(`  ${bug.padEnd(38)} ${v.hit}/${v.of}`);
}
console.log(`  ${"TUNING TOTAL".padEnd(38)} ${hit}/${of} (${of ? Math.round((hit / of) * 100) : 0}%)`);
if (heldOutOf) {
  console.log(`  ${"held-out".padEnd(38)} ${flag("reveal") ? `${heldOutHit}/${heldOutOf}` : `${heldOutOf} judgements, hidden`}`);
}

const outDir = path.join(here, "../../../harness-results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `plans-${label}.json`),
  JSON.stringify({ label, repeat, tuning: { hit, of }, heldOut: { hit: heldOutHit, of: heldOutOf }, perBug: Object.fromEntries(tally) }, null, 2),
);
