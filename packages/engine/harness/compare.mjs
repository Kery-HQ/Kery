#!/usr/bin/env node
/**
 * Compare benchmark runs, tuning set only, with per-bug detail.
 *
 * Answers the question every prompt change has to survive: did the total move
 * beyond noise, and did any individual bug REGRESS? A change that lifts the
 * total while silently dropping a bug another config caught is the failure mode
 * that burned v3 (it helped one app's validation bug and took chatific from
 * 3/3 to 1/3), so per-bug deltas matter more than the headline.
 *
 *   node harness/compare.mjs review-v4 v6-ripr-setup
 *   node harness/compare.mjs                      # every run, newest last
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../../../harness-results");
const suite = JSON.parse(fs.readFileSync(path.join(here, "suite.json"), "utf8"));
const heldOut = new Set(suite.cases.filter((c) => c.heldOut).map((c) => c.id));
const wanted = process.argv.slice(2);

const docs = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    try {
      return { file: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter(({ doc }) => (wanted.length ? wanted.some((w) => (doc.label ?? "").includes(w)) : true))
  .sort((a, b) => a.file.localeCompare(b.file));

// A run exists twice once it has been rescored: the original regex-scored file
// and the .rescored.json the judge wrote. Keep only the judged copy, otherwise
// every config is listed twice with two different numbers.
const byRun = new Map();
for (const entry of docs) {
  const key = entry.file.replace(".rescored.json", ".json");
  const existing = byRun.get(key);
  if (!existing || entry.file.includes(".rescored.")) byRun.set(key, entry);
}
docs.length = 0;
docs.push(...[...byRun.values()].sort((a, b) => a.file.localeCompare(b.file)));

// A bug's score for a config: how many of its attempts caught it.
const table = [];
for (const { doc } of docs) {
  const perBug = new Map();
  let caught = 0;
  let planted = 0;
  for (const r of doc.results ?? []) {
    if (heldOut.has(r.case)) continue;
    for (const s of r.judged ?? r.scored ?? []) {
      const prev = perBug.get(s.id) ?? { hit: 0, of: 0 };
      perBug.set(s.id, { hit: prev.hit + (s.caught ? 1 : 0), of: prev.of + 1 });
      planted++;
      if (s.caught) caught++;
    }
  }
  if (planted === 0) continue;
  table.push({ label: doc.label ?? "?", mode: doc.mode ?? "?", caught, planted, perBug });
}

if (table.length === 0) {
  console.error("No runs matched.");
  process.exit(1);
}

console.log("TUNING SET");
for (const t of table) {
  console.log(`  ${t.label.padEnd(22)} ${t.mode.padEnd(9)} ${t.caught}/${t.planted}  (${Math.round((t.caught / t.planted) * 100)}%)`);
}

const allBugs = [...new Set(table.flatMap((t) => [...t.perBug.keys()]))].sort();
console.log("\nPER-BUG (caught / attempts)");
const head = table.map((t) => t.label.slice(0, 14).padStart(15)).join("");
console.log(`  ${"bug".padEnd(38)}${head}`);
for (const bug of allBugs) {
  const cells = table.map((t) => {
    const v = t.perBug.get(bug);
    return (v ? `${v.hit}/${v.of}` : "—").padStart(15);
  });
  console.log(`  ${bug.padEnd(38)}${cells.join("")}`);
}

// Regressions are the point of this script: flag any bug the newest config
// catches strictly less often than the best earlier config did.
if (table.length >= 2) {
  const latest = table[table.length - 1];
  const regressions = [];
  for (const bug of allBugs) {
    const now = latest.perBug.get(bug);
    if (!now) continue;
    // Only compare against configs of the SAME mode. The scripted ceiling uses
    // hand-written plans, so treating it as a baseline reports every gap to the
    // ceiling as a "regression" and buries real ones.
    const peers = table.slice(0, -1).filter((t) => t.mode === latest.mode);
    if (peers.length === 0) continue;
    const bestBefore = Math.max(
      ...peers.map((t) => {
        const v = t.perBug.get(bug);
        return v && v.of ? v.hit / v.of : 0;
      }),
    );
    const rateNow = now.of ? now.hit / now.of : 0;
    if (rateNow < bestBefore) regressions.push({ bug, was: bestBefore, now: rateNow });
  }
  console.log(`\nREGRESSIONS vs best earlier config (${latest.label}):`);
  if (regressions.length === 0) console.log("  none");
  for (const r of regressions) {
    console.log(`  ${r.bug.padEnd(38)} ${Math.round(r.was * 100)}% → ${Math.round(r.now * 100)}%`);
  }
}
