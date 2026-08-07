/**
 * Deterministic grounding check for reported findings.
 *
 * Most false reports verified by hand were about VALUES: a total said to be
 * wrong, a promo said not to have applied, a message said to be missing. Those
 * are checkable without asking a model anything — if a report quotes a figure
 * or a phrase, that text should appear somewhere in what the run actually
 * recorded. When it appears nowhere, the report is describing something the run
 * never saw.
 *
 * No LLM call, no extra browser pass, no judgement: it compares the literals in
 * the report against the run's own observations. Cheap enough to run always,
 * and it cannot invent a verdict of its own.
 *
 * MEASURED AND NOT ENABLED. Kept because the idea is sound and the data is
 * worth preserving, but it did not pay its way:
 *
 *   few-shot only        noise 2.13/run   detection 59%
 *   + grounding (all)    noise 1.71       detection 47%
 *   + grounding (strong) noise 2.60       detection 48%
 *
 * The first version bought the best noise of any change tried, by deleting real
 * findings: summary-text-clipped fell 6/6 to 1/6 and counter-ignores-vision 5/6
 * to 2/6. Those reports cite numbers the agent DERIVED — an estimated control
 * size, a computed row count, text seen as cut off and so unquotable — which
 * have no reason to appear in what it transcribed.
 *
 * Restricting it to money amounts and quoted phrases was expected to fix that.
 * It did not: detection stayed at 48% while the noise benefit disappeared,
 * because it still drops roughly one finding per run. Enable with
 * KERY_GROUNDING=1 only alongside a fresh measurement on both axes.
 */
import type { RunStep } from "./agent.js";
import { logger } from "./logger.js";

/**
 * Two tiers. STRONG literals — money amounts and quoted phrases — identify a
 * specific thing on screen. WEAK literals — bare numbers — match by accident:
 * a claim about promo "TEAM15" was counted as grounded because the trace
 * contained the digits 15, which proved nothing.
 */
function literalsIn(text: string): { strong: string[]; weak: string[] } {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const m of text.matchAll(/\$\s?\d[\d,]*\.?\d*/g)) strong.add(m[0].replace(/\s/g, ""));
  for (const m of text.matchAll(/[“"']([^“”"']{3,40})[”"']/g)) strong.add(m[1].trim());
  for (const m of text.matchAll(/\b\d{2,}(?:\.\d+)?\b/g)) weak.add(m[0]);
  return {
    strong: [...strong].filter((l) => l.length >= 2),
    weak: [...weak].filter((l) => l.length >= 2),
  };
}

/** Normalised haystack of everything the run recorded seeing. */
function traceText(steps: RunStep[]): string {
  return steps
    .map((s) => [s.observation, s.assertion, s.target, s.value, s.reasoning].filter(Boolean).join(" "))
    .join(" \n ")
    .replace(/\s+/g, " ");
}

export type GroundingResult = { kept: RunStep[]; dropped: RunStep[] };

export function dropUngroundedFindings(bugs: RunStep[], steps: RunStep[]): GroundingResult {
  if (bugs.length === 0 || steps.length === 0) return { kept: bugs, dropped: [] };
  const hay = traceText(steps).toLowerCase();
  const kept: RunStep[] = [];
  const dropped: RunStep[] = [];

  for (const bug of bugs) {
    const text = `${bug.reasoning ?? ""} ${bug.assertion ?? ""}`.trim();
    const { strong } = literalsIn(text);
    if (strong.length === 0) {
      // Only money amounts and quoted phrases are judged here. Bare numbers are
      // often DERIVED rather than read — an estimated control size, a computed
      // row count, text observed as cut off and so unquotable — and judging
      // those cost real detections: summary-text-clipped fell 6/6 to 1/6,
      // counter-ignores-vision-filter 5/6 to 2/6. A number the agent worked out
      // has no reason to appear in what it transcribed.
      kept.push(bug);
      continue;
    }
    // A report quoting specific on-screen text or figures must have at least
    // one of them appear in what the run actually recorded.
    const grounded = strong.some((l) => hay.includes(l.toLowerCase()));
    if (grounded) kept.push(bug);
    else {
      dropped.push(bug);
      logger.debug(
        { literals: strong.slice(0, 4), claim: text.slice(0, 120) },
        "Finding cites values that appear nowhere in the run's observations",
      );
    }
  }

  if (dropped.length > 0) {
    logger.info({ kept: kept.length, dropped: dropped.length }, "Grounding check removed findings citing unseen values");
  }
  return { kept, dropped };
}
