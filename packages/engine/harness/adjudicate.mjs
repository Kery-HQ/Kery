#!/usr/bin/env node
/**
 * First-pass triage of issues reported against known-clean pages.
 *
 * These pages were verified defect-free before the run, so a reported issue is
 * a genuine pre-existing bug, a false positive, or a subjective opinion. This
 * pass asks a judge to sort them and, crucially, to state what would have to be
 * TRUE on the page for the claim to hold — that gives a concrete predicate to
 * check in a browser rather than a vibe.
 *
 * The judge's verdict is a triage aid, NOT the answer: anything it calls real
 * gets verified by hand before it counts. A model grading another model's
 * output is not evidence, and treating it as such is how a false-positive
 * measurement quietly becomes fiction.
 *
 *   node harness/adjudicate.mjs --label noise-v15
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../../../harness-results");
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const label = arg("label", "noise-v15");
const apiKey = process.env.OPENAI_API_KEY;
const MODEL = process.env.KERY_JUDGE_MODEL || "terra";

const doc = JSON.parse(fs.readFileSync(path.join(dir, `${label}-issues.json`), "utf8"));

const SYSTEM = `You triage bug reports produced by an automated browser tester against a page that was verified to be CORRECT before the run.

For each report decide:
- "real": it describes a concrete, reproducible defect in behaviour or presentation. Only choose this if the report names specific observed evidence.
- "false": it contradicts how the page actually works, describes something that did not happen, invents an element or value, reports a transient loading state as a defect, or reports the tester's own failure to operate the page as a product bug.
- "subjective": the behaviour is as designed and the report is a matter of taste or preference, not a defect.

Also give "checkable": one sentence stating what would have to be observably true on the page for the report to be correct, phrased so a person could verify it in a browser in one step.

Be sceptical. The page is believed correct, so "real" is the exception and needs evidence in the report itself.

Return JSON only: {"verdicts":[{"index": number, "verdict": "real"|"false"|"subjective", "checkable": string, "why": string}]}`;

const items = [...new Map(doc.issues.map((i) => [`${i.case}::${i.text.slice(0, 70)}`, i])).values()];
if (items.length === 0) {
  console.log("No issues were reported against the clean corpus — nothing to adjudicate.");
  process.exit(0);
}

const user = items.map((it, n) => `[${n}] page: ${it.case}\n    report: ${it.text.slice(0, 400)}`).join("\n\n");

const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    max_completion_tokens: 6000,
    response_format: { type: "json_object" },
  }),
  signal: AbortSignal.timeout(180_000),
});
if (!res.ok) {
  console.error(`judge failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  process.exit(1);
}
const parsed = JSON.parse((await res.json()).choices[0].message.content.replace(/^```(?:json)?|```$/g, ""));
const byIndex = new Map((parsed.verdicts ?? []).map((v) => [v.index, v]));

const tally = { real: 0, false: 0, subjective: 0, unjudged: 0 };
const rows = items.map((it, n) => {
  const v = byIndex.get(n);
  const verdict = v?.verdict ?? "unjudged";
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  return { ...it, verdict, checkable: v?.checkable ?? "", why: v?.why ?? "" };
});

console.log(`TRIAGE (first pass — every "real" still needs hand verification)\n`);
for (const [i, r] of rows.entries()) {
  console.log(`[${i}] ${r.verdict.toUpperCase().padEnd(11)} ${r.case}`);
  console.log(`     report: ${r.text.slice(0, 170)}`);
  if (r.checkable) console.log(`     verify: ${r.checkable.slice(0, 170)}`);
  console.log("");
}
console.log(`unique reports ${rows.length}  |  real ${tally.real}  false ${tally.false}  subjective ${tally.subjective}`);

fs.writeFileSync(path.join(dir, `${label}-triage.json`), JSON.stringify({ label, tally, rows }, null, 2));
