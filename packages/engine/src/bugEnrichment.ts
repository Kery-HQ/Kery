import type { Bug } from "./types.js";

/** Raw bug step from the agent (RunStep with action "bug") */
type AgentBugStep = {
  index?: number;
  action?: string;
  reasoning?: string;
  url?: string;
  bugType?: "visual" | "functional" | "ux" | "other";
  severity?: "low" | "medium" | "high";
  screenshotBase64?: string;
  stepsToReproduce?: string[];
  source?: "navigator" | "review" | "network" | "pathgen";
  [k: string]: unknown;
};

const MAX_NAME_LENGTH = 80;
const DEFAULT_CATEGORY: Bug["category"] = "other";
const DEFAULT_SEVERITY: Bug["severity"] = "medium";

// ─── Dedup Helpers ────────────────────────────────────────────────────────────

const STOP_WORDS = /\b(the|a|an|is|was|are|were|has|have|this|that|it|its|be|been|being|do|does|did|not|no|but|or|and|so|if|on|in|at|to|for|of|with|by)\b/g;

/** Normalize a description for exact-key dedup (original behavior) */
const normalizeDesc = (s: string) =>
  s.toLowerCase().replace(STOP_WORDS, "")
    .replace(/\s+/g, " ").trim().slice(0, 100);

/** Strip URL to origin + pathname for comparison */
const normalizeUrl = (s: string) => s.trim().replace(/\?.*$/, "");

/** Normalize a bug name for fuzzy comparison: lowercase, strip punctuation/whitespace/stop-words */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")     // strip punctuation
    .replace(STOP_WORDS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Simple trigram-based similarity (0-1). Returns true if similarity > 0.7. */
function isSimilarName(a: string, b: string): boolean {
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

function getTrigrams(s: string): Set<string> {
  const trigrams = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Enriches agent bug steps into full Bug records for persistence and UI.
 */
export function enrichBugsForRun(
  runId: string,
  reportedAt: string,
  runLabel: string | null | undefined,
  agentBugs: AgentBugStep[] | null | undefined,
  stepsDetail?: Array<{ index?: number; action?: string; target?: string; value?: string; url?: string; status?: string }>,
): Bug[] {
  if (!Array.isArray(agentBugs) || agentBugs.length === 0) return [];

  const seen = new Set<string>();
  const seenNormNames: string[] = [];
  const dedupedBugs = agentBugs.filter((b) => {
    const urlKey = normalizeUrl(b.url ?? "");
    const descKey = normalizeDesc(b.reasoning ?? "");
    const key = `${urlKey}|${b.bugType ?? "other"}|${descKey}`;
    // Exact tuple dedup
    if (seen.has(key)) return false;
    // Fuzzy name dedup: if normalized name is very similar to an existing bug, skip
    const normName = normalizeName(b.reasoning ?? "");
    if (seenNormNames.some(existing => isSimilarName(existing, normName))) return false;
    seen.add(key);
    seenNormNames.push(normName);
    return true;
  });

  return dedupedBugs.map((b) => {
    const description = b.reasoning?.trim() ?? "";
    const name =
      description.length > MAX_NAME_LENGTH
        ? description.slice(0, MAX_NAME_LENGTH).trim() + "\u2026"
        : description || "Bug";

    const category: Bug["category"] =
      b.bugType && ["visual", "functional", "ux", "other"].includes(b.bugType)
        ? b.bugType
        : DEFAULT_CATEGORY;

    const severity: Bug["severity"] =
      b.severity && ["low", "medium", "high"].includes(b.severity)
        ? b.severity
        : DEFAULT_SEVERITY;

    let stepsToReproduce = Array.isArray(b.stepsToReproduce) && b.stepsToReproduce.length > 0
      ? b.stepsToReproduce
      : [];
    if (stepsToReproduce.length === 0 && stepsDetail && typeof b.index === "number") {
      const preceding = stepsDetail
        .filter(s => (s.index ?? 0) <= b.index! && s.action !== "bug" && s.status === "ok")
        .slice(-5);
      stepsToReproduce = preceding.map(s =>
        `${s.action}${s.target ? ` "${s.target}"` : ""}${s.value ? ` = "${s.value}"` : ""}${s.url ? ` on ${s.url}` : ""}`
      );
    }

    return {
      name,
      description,
      category,
      severity,
      status: "open" as const,
      screenshotBase64: b.screenshotBase64 ?? null,
      stepsToReproduce,
      url: b.url ?? null,
      runId,
      runLabel: runLabel ?? null,
      reportedAt,
      environment: null,
      index: typeof b.index === "number" ? b.index : undefined,
      source: (b.source === "navigator" || b.source === "review" || b.source === "pathgen") ? b.source : undefined,
    };
  });
}
