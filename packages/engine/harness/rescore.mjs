#!/usr/bin/env node
/**
 * Re-score existing benchmark result files with the semantic judge.
 *
 * The original regex scorer under-counted (it wanted "unchanged" where the run
 * said "remains"), so every historical number is suspect. This re-reads the
 * stored findings — no browser runs, no extra cost beyond the judge — and
 * prints a corrected comparison table.
 *
 *   node harness/rescore.mjs --suite ../../harness-suite.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCase } from "./judge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const suite = JSON.parse(fs.readFileSync(path.resolve(arg("suite", path.join(here, "../../../harness-suite.json"))), "utf8"));
const caseById = new Map(suite.cases.map((c) => [c.id, c]));
const dir = path.resolve(arg("dir", path.join(here, "../../../harness-results")));
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("rescored")).sort();
const table = [];

for (const file of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  let caught = 0;
  let planted = 0;
  const perBug = {};
  for (const r of doc.results ?? []) {
    const testCase = caseById.get(r.case);
    if (!testCase) continue;
    // Reconstruct the shape judgeCase expects from what the result stored.
    const runResult = {
      bugsFound: (r.findingTexts ?? []).map((t) => ({ reasoning: t })),
      verifications: r.verifications ?? [],
    };
    const scored = await judgeCase(testCase, runResult, apiKey);
    for (const s of scored) {
      planted++;
      if (s.caught) caught++;
      perBug[s.id] = (perBug[s.id] ?? 0) + (s.caught ? 1 : 0);
    }
    r.judged = scored;
  }
  doc.judgedTotals = { caught, planted };
  fs.writeFileSync(path.join(dir, file.replace(".json", ".rescored.json")), JSON.stringify(doc, null, 2));
  table.push({ label: doc.label, mode: doc.mode ?? "?", regex: `${doc.totals.caught}/${doc.totals.planted}`, judged: `${caught}/${planted}`, pct: planted ? Math.round((caught / planted) * 100) : 0, perBug });
  console.log(`${(doc.label ?? file).padEnd(20)} mode=${(doc.mode ?? "?").padEnd(9)} regex=${String(`${doc.totals.caught}/${doc.totals.planted}`).padEnd(7)} judged=${`${caught}/${planted}`.padEnd(7)} (${planted ? Math.round((caught / planted) * 100) : 0}%)`);
}

console.log("\nPer-bug catch counts (judged):");
const allBugs = new Set(table.flatMap((t) => Object.keys(t.perBug)));
for (const bug of allBugs) {
  console.log(`  ${bug.padEnd(38)} ${table.map((t) => `${t.label}:${t.perBug[bug] ?? 0}`).join("  ")}`);
}
