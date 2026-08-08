/**
 * Spawn evidence bugs from contradicted verification checks.
 *
 * The navigator files a `report_bug` for a defect only some of the time — the
 * same gift-note page yields five screenshot-bearing bugs one run and zero the
 * next, purely on navigator variance. The verifier, grading the trace, catches
 * the defect either way and marks the check "contradicted" — but a verification
 * check carries no screenshot, so those runs show a failed check with no image.
 *
 * This turns each contradicted check that no bug already covers into a
 * navigator-style bug, reusing the screenshot from the step the verifier cited
 * (falling back to the final clean frame). It is inserted BEFORE dedup + triage,
 * so duplicates of a real navigator bug collapse and the normal noise gates
 * still apply; the localizer then gives it a zoomed region like any other bug.
 *
 * OFF by default (it changes what gets filed): enable with KERY_VERIFIER_BUGS=1.
 */
import type { RunStep } from "./agent.js";
import type { RunVerification } from "./verificationAgent.js";

function isEnabled(): boolean {
  return process.env.KERY_VERIFIER_BUGS === "1";
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "and", "or",
  "in", "on", "at", "for", "with", "that", "this", "it", "its", "as", "not", "no", "but",
  "should", "must", "does", "did", "do", "has", "have", "had", "after", "before", "when",
  "then", "than", "so", "if", "into", "from", "by", "note", "page", "field", "text",
]);

function tokens(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Shared content words between a check and an existing bug. */
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * @param verifications  the verifier's evidence record for this run
 * @param existingBugs   bugs already merged (navigator/review/filmstrip) — a
 *                       contradicted check overlapping one of these is skipped
 * @param screenshotsByStep  clean frame per step index
 * @param fallbackScreenshot base64 final frame, used when the cited step has none
 */
export function bugsFromContradictedChecks(
  verifications: RunVerification[],
  existingBugs: RunStep[],
  screenshotsByStep: Map<number, string> | undefined,
  fallbackScreenshot: string | undefined,
): RunStep[] {
  if (!isEnabled()) return [];

  const contradicted = verifications.filter((v) => v.status === "contradicted");
  if (contradicted.length === 0) return [];

  // Content signatures of bugs we already have, so we don't double-file.
  const existingSigs = existingBugs
    .filter((b) => b.action === "bug")
    .map((b) => tokens(`${(b as Record<string, unknown>).name ?? ""} ${b.reasoning ?? ""}`));

  const out: RunStep[] = [];
  let seq = 0;
  for (const v of contradicted) {
    const sig = tokens(`${v.title ?? ""} ${v.claim} ${v.evidence}`);
    if (sig.size === 0) continue;
    // Already represented by a real navigator/review/filmstrip bug → skip.
    if (existingSigs.some((e) => overlap(sig, e) >= 2)) continue;

    const shot =
      (typeof v.stepIndex === "number" ? screenshotsByStep?.get(v.stepIndex) : undefined) ??
      fallbackScreenshot;
    if (!shot) continue; // no evidence frame → nothing to show; leave as a check

    const headline = v.title ? `${v.title}: ${v.claim}` : v.claim;
    out.push({
      index: 40_000 + seq++,
      action: "bug",
      reasoning: v.evidence ? `${headline} — ${v.evidence}` : headline,
      status: "ok",
      fromMemory: false,
      bugType: "functional",
      severity: "medium",
      source: "navigator",
      at: Date.now(),
      screenshotBase64: shot,
    });
  }
  return out;
}
