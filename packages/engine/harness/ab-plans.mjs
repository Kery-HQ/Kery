#!/usr/bin/env node
/**
 * Blind A/B of review-plan quality on REAL historical PR diffs.
 *
 * The 142 benchmark PRs from earlier rounds have no preserved planted-bug
 * ground truth, so a catch rate cannot be computed on them. What can be
 * measured is the thing that actually changed: the plan. For each diff both
 * reviewer configurations produce a plan, and a judge — shown the diff and the
 * two plans in a randomised order, with no idea which is which — says which
 * would more likely expose a real defect.
 *
 * Blind and order-randomised because a judge told which plan is "new" will
 * favour it, and that would quietly manufacture the improvement being measured.
 *
 *   KERY_OLD_REVIEW=... KERY_PR_REVIEW_PATH=... node harness/ab-plans.mjs --diffs /tmp/diffs
 */
import fs from "node:fs";
import path from "node:path";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const apiKey = process.env.OPENAI_API_KEY;
const dir = arg("diffs", "/tmp/diffs");
const MODEL = process.env.KERY_JUDGE_MODEL || "terra";

const { reviewPullRequest, intentWithPlan } = await import(process.env.KERY_PR_REVIEW_PATH);
const oldCfg = JSON.parse(fs.readFileSync(arg("oldcfg", "/tmp/oldcfg.json"), "utf8"));

function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const m = chunk.match(/^a\/(\S+) b\/(\S+)/);
    if (!m) continue;
    const body = chunk.slice(chunk.indexOf("@@") >= 0 ? chunk.indexOf("@@") : 0);
    files.push({ filename: m[2], patch: body, additions: 0, deletions: 0 });
  }
  return files;
}

/** Reproduce the previous reviewer: same call, old truncation, old prompt, old cap. */
async function oldPlan(files, title, body) {
  const trimmed = files
    .map((f) => `--- ${f.filename}\n${f.patch.slice(0, oldCfg.perFile)}`)
    .join("\n\n")
    .slice(0, oldCfg.total);
  const user = `PR #1: ${title}\n\n${body}\n\nChanged files:\n${files.map((f) => "- " + f.filename).join("\n")}\n\nDiff:\n${trimmed}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.KERY_AUXILIARY_MODEL?.replace(/^openai\//, "") || "luna",
      messages: [{ role: "system", content: oldCfg.system }, { role: "user", content: user }],
      max_completion_tokens: 4000,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`old review ${res.status}`);
  const j = JSON.parse((await res.json()).choices[0].message.content.replace(/^```(?:json)?|```$/g, ""));
  const checks = (j.testPlan ?? []).slice(0, oldCfg.cap);
  return `${j.intent ?? ""}\n${checks.map((c, i) => `${i + 1}. ${c.action} — expect: ${c.expect}`).join("\n")}`;
}

const JUDGE = `You compare two browser test plans written for the SAME code change.

Decide which plan is more likely to EXPOSE a real defect introduced by that change.

A better plan reaches the changed behaviour, uses inputs for which correct and broken code would visibly differ, and states expectations precise enough to fail. A worse plan describes the area vaguely, uses default or obviously-invalid inputs, or only confirms things work.

Ignore length and formatting. Judge only defect-finding power.
Answer "A", "B", or "TIE". Return JSON: {"winner":"A"|"B"|"TIE","why":string}`;

async function judge(diff, a, b) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: JUDGE },
        { role: "user", content: `CODE CHANGE:\n${diff.slice(0, 14000)}\n\nPLAN A:\n${a}\n\nPLAN B:\n${b}` },
      ],
      max_completion_tokens: 1200,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`judge ${res.status}`);
  return JSON.parse((await res.json()).choices[0].message.content.replace(/^```(?:json)?|```$/g, ""));
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".patch"));
let nw = 0, no = 0, tie = 0, failed = 0;
// Deterministic alternation instead of randomness: seeded shuffling is not
// available here, and alternating removes any fixed position bias just as well.
let flip = false;

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const parsed = parseDiff(text);
  if (parsed.length === 0) { failed++; continue; }
  const label = f.replace(".patch", "");
  try {
    const review = await reviewPullRequest(
      { number: 1, title: label, body: "", headSha: "x", branch: "b" }, parsed, { reachability: [], conventions: [] });
    const newP = intentWithPlan(review);
    const oldP = await oldPlan(parsed, label, "");
    flip = !flip;
    const [A, B] = flip ? [newP, oldP] : [oldP, newP];
    const verdict = await judge(text, A, B);
    const winnerIsNew = verdict.winner === "TIE" ? null : (verdict.winner === "A") === flip;
    if (winnerIsNew === null) { tie++; console.log(`  ${label.padEnd(22)} TIE`); }
    else if (winnerIsNew) { nw++; console.log(`  ${label.padEnd(22)} NEW`); }
    else { no++; console.log(`  ${label.padEnd(22)} OLD`); }
  } catch (e) {
    failed++;
    console.log(`  ${label.padEnd(22)} ERROR ${String(e).slice(0, 60)}`);
  }
}

const decided = nw + no;
console.log(`\nBLIND A/B over ${files.length} historical PR diffs`);
console.log(`  new config wins : ${nw}`);
console.log(`  old config wins : ${no}`);
console.log(`  ties            : ${tie}`);
console.log(`  errors          : ${failed}`);
if (decided) console.log(`  new win rate    : ${Math.round((nw / decided) * 100)}% of decided comparisons`);
