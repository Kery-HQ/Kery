#!/usr/bin/env node
/**
 * Collect every issue Kery reported against KNOWN-CLEAN pages.
 *
 * These pages were verified defect-free before the run, so each reported issue
 * is one of: a genuine pre-existing bug the verification missed, a false
 * positive, or a subjective opinion. Every one has to be adjudicated by hand
 * against the real page — the agent's own confidence is not evidence.
 *
 * Reads RAW per-run findings. The product's triage dedupes issues before they
 * reach a user, which would collapse repeated false positives and make the
 * noise look smaller than it is; measuring pre-dedup keeps that honest. The
 * grouping below is reported ALONGSIDE the raw count, never instead of it.
 *
 *   node harness/collect-noise.mjs --label noise-v15
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
const label = arg("label", "noise");

const files = fs.readdirSync(dir).filter((f) => f.startsWith(label) && f.endsWith(".json") && !f.includes("rescored"));
if (files.length === 0) {
  console.error(`No result files for label "${label}"`);
  process.exit(1);
}

const issues = [];
let runs = 0;
let cleanRuns = 0;

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const r of doc.results ?? []) {
    runs++;
    const reported = [
      ...(r.findingTexts ?? []).map((t) => ({ kind: "issue", text: t })),
      ...(r.verifications ?? [])
        .filter((v) => v.status === "contradicted")
        .map((v) => ({ kind: "failed-check", text: `${v.claim} — ${v.evidence ?? ""}` })),
    ];
    if (reported.length === 0) cleanRuns++;
    for (const item of reported) issues.push({ case: r.case, attempt: r.attempt, ...item });
  }
}

// Near-duplicate grouping, shown next to the raw number rather than replacing it.
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
const groups = new Map();
for (const i of issues) {
  const key = `${i.case}::${norm(i.text)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(i);
}

console.log(`RUNS               ${runs}`);
console.log(`RUNS WITH NO ISSUE ${cleanRuns} (${Math.round((cleanRuns / runs) * 100)}%)`);
console.log(`ISSUES RAW         ${issues.length}   <- what a user sees per run, before triage dedup`);
console.log(`ISSUES DEDUPED     ${groups.size}   <- what triage would show`);
console.log(`ISSUES PER RUN     ${(issues.length / runs).toFixed(2)}\n`);

const byCase = new Map();
for (const i of issues) byCase.set(i.case, (byCase.get(i.case) ?? 0) + 1);
console.log("PER SURFACE (raw issue count over all attempts)");
for (const [c, n] of [...byCase].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(26)} ${n}`);

console.log("\nEVERY REPORTED ISSUE — each needs a verdict");
let n = 0;
for (const [key, items] of groups) {
  n++;
  const [caseId] = key.split("::");
  console.log(`\n[${n}] ${caseId}  (reported ${items.length}x, ${items[0].kind})`);
  console.log(`    ${items[0].text.slice(0, 300)}`);
}

fs.writeFileSync(
  path.join(dir, `${label}-issues.json`),
  JSON.stringify({ label, runs, cleanRuns, raw: issues.length, deduped: groups.size, issues }, null, 2),
);
