import type { RunStep } from "./agent.js";

const STOP_WORDS = /\b(the|a|an|is|was|are|were|has|have|this|that|it|its|be|been|being|do|does|did|not|no|but|or|and|so|if|on|in|at|to|for|of|with|by)\b/g;

/** Normalize a description for exact-key dedup */
export const normalizeBugDesc = (s: string) =>
  s.toLowerCase().replace(STOP_WORDS, "").replace(/\s+/g, " ").trim().slice(0, 100);

export const normalizeBugUrl = (s: string) => s.trim().replace(/\?.*$/, "");

export function normalizeBugName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(STOP_WORDS, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTrigrams(s: string): Set<string> {
  const trigrams = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3));
  }
  return trigrams;
}

export function isSimilarBugName(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const trigramsA = getTrigrams(a);
  const trigramsB = getTrigrams(b);
  if (trigramsA.size === 0 || trigramsB.size === 0) return a === b;
  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }
  const similarity = (2 * intersection) / (trigramsA.size + trigramsB.size);
  return similarity > 0.7;
}

/**
 * Dedupe merged run bug steps (navigator + review + filmstrip) before enrichment.
 */
export function dedupeRunStepBugs(steps: RunStep[]): RunStep[] {
  const seen = new Set<string>();
  const seenNormNames: string[] = [];
  const out: RunStep[] = [];
  for (const b of steps) {
    if (b.action !== "bug") continue;
    const urlKey = normalizeBugUrl(b.url ?? "");
    const descKey = normalizeBugDesc(b.reasoning ?? "");
    const key = `${urlKey}|${b.bugType ?? "other"}|${descKey}`;
    if (seen.has(key)) continue;
    const normName = normalizeBugName(b.reasoning ?? "");
    if (seenNormNames.some((existing) => isSimilarBugName(existing, normName))) continue;
    seen.add(key);
    seenNormNames.push(normName);
    out.push(b);
  }
  return out;
}
