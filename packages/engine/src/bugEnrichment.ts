import type { Bug } from "./types.js";
import {
  isSimilarBugName,
  normalizeBugDesc,
  normalizeBugName,
  normalizeBugUrl,
} from "./bugDedup.js";

/** Raw bug step from the agent (RunStep with action "bug") */
type AgentBugStep = {
  index?: number;
  action?: string;
  reasoning?: string;
  url?: string;
  bugType?: "visual" | "functional" | "ux" | "other";
  severity?: "low" | "medium" | "high";
  screenshotPath?: string;
  source?: "navigator" | "review" | "network" | "pathgen" | "filmstrip";
  region?: { x: number; y: number; w: number; h: number };
  [k: string]: unknown;
};

const MAX_NAME_LENGTH = 80;
const DEFAULT_CATEGORY: Bug["category"] = "other";
const DEFAULT_SEVERITY: Bug["severity"] = "medium";

/** Short title: first sentence or line, distinct from full description. */
export function deriveBugTitle(description: string): string {
  const t = description.trim();
  if (!t) return "Issue";
  const firstLine = t.split("\n")[0]?.trim() ?? t;
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  let title =
    sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1).trim() : firstLine;
  if (title.length > MAX_NAME_LENGTH) {
    title = title.slice(0, MAX_NAME_LENGTH - 1).trim() + "\u2026";
  }
  if (title.length < 8 && t.length > firstLine.length) {
    const more = t.slice(0, MAX_NAME_LENGTH).trim();
    title = more.length > MAX_NAME_LENGTH - 1 ? more.slice(0, MAX_NAME_LENGTH - 1) + "\u2026" : more;
  }
  if (title === t && t.length > MAX_NAME_LENGTH) {
    title = t.slice(0, MAX_NAME_LENGTH - 1).trim() + "\u2026";
  }
  return title || "Issue";
}

/**
 * Enriches agent bug steps into full Bug records for persistence and UI.
 */
export function enrichBugsForRun(
  runId: string,
  reportedAt: string,
  runLabel: string | null | undefined,
  agentBugs: AgentBugStep[] | null | undefined,
): Bug[] {
  if (!Array.isArray(agentBugs) || agentBugs.length === 0) return [];

  const seen = new Set<string>();
  const seenNormNames: string[] = [];
  const dedupedBugs = agentBugs.filter((b) => {
    const urlKey = normalizeBugUrl(b.url ?? "");
    const descKey = normalizeBugDesc(b.reasoning ?? "");
    const key = `${urlKey}|${b.bugType ?? "other"}|${descKey}`;
    if (seen.has(key)) return false;
    const normName = normalizeBugName(b.reasoning ?? "");
    if (seenNormNames.some((existing) => isSimilarBugName(existing, normName))) return false;
    seen.add(key);
    seenNormNames.push(normName);
    return true;
  });

  return dedupedBugs.map((b) => {
    const description = b.reasoning?.trim() ?? "";
    const name = deriveBugTitle(description);

    const category: Bug["category"] =
      b.bugType && ["visual", "functional", "ux", "other"].includes(b.bugType)
        ? b.bugType
        : DEFAULT_CATEGORY;

    const severity: Bug["severity"] =
      b.severity && ["low", "medium", "high"].includes(b.severity)
        ? b.severity
        : DEFAULT_SEVERITY;

    return {
      name,
      description,
      category,
      severity,
      status: "open" as const,
      screenshotPath: b.screenshotPath ?? null,
      url: b.url ?? null,
      runId,
      runLabel: runLabel ?? null,
      reportedAt,
      environment: null,
      index: typeof b.index === "number" ? b.index : undefined,
      source:
        b.source === "navigator" || b.source === "review" || b.source === "pathgen" || b.source === "filmstrip"
          ? b.source
          : undefined,
      region:
        b.region &&
        typeof b.region === "object" &&
        typeof (b.region as { x?: number }).x === "number" &&
        typeof (b.region as { y?: number }).y === "number" &&
        typeof (b.region as { w?: number }).w === "number" &&
        typeof (b.region as { h?: number }).h === "number"
          ? {
              x: (b.region as { x: number }).x,
              y: (b.region as { y: number }).y,
              w: (b.region as { w: number }).w,
              h: (b.region as { h: number }).h,
            }
          : undefined,
    };
  });
}

export { normalizeBugDesc, normalizeBugName, normalizeBugUrl };
