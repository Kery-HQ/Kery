/**
 * Second-pass confirmation of candidate findings.
 *
 * Rule and prompt changes plateaued at ~1.75 false reports per run against
 * pages verified correct beforehand, with a measured band of +/-0.16 across
 * three identical runs. Hand-checking those reports showed why no instruction
 * fixes them: the agent sincerely believes them. It reported that a promo was
 * rejected when the trace showed it applied, that a stepper changed the wrong
 * row when only the aimed-at row moved, that a Close button failed when it
 * works. A model cannot be told out of a belief it holds honestly.
 *
 * The only thing that settles those is fresh evidence, so this re-drives the
 * specific interaction in the live browser and keeps a finding only when the
 * second attempt reproduces it. Cost is bounded: one short pass for the whole
 * candidate list, not one per finding.
 */
import type { Page } from "playwright";
import { runAgent, type RunStep, type LLMCallRecord } from "./agent.js";
import { runVerificationReview } from "./verificationAgent.js";
import { logger } from "./logger.js";

export type ConfirmationOutcome = {
  kept: RunStep[];
  dropped: RunStep[];
  llmCalls: LLMCallRecord[];
  /** Verdict per extra claim passed in (contradicted checks), same order. */
  extraReproduced: boolean[];
};

/**
 * Strips a claim down to the action and the thing to look at, dropping the
 * verdict. "The promo TEAM15 is rejected and no discount applies" becomes
 * "apply promo TEAM15, then report the discount shown" — a question whose
 * answer is the same whether or not the original report was right.
 */
function neutralQuestion(claim: string): string {
  const stripped = claim
    .replace(/\b(incorrectly|wrongly|erroneously|fails? to|does not|doesn't|never|instead of|rather than|should have|expected)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return `Carry out this interaction and report what is shown afterwards: ${stripped.slice(0, 220)}`;
}

/** Claim text for a candidate bug, as the confirmation pass should re-test it. */
function claimOf(bug: RunStep): string {
  return (bug.reasoning ?? bug.assertion ?? bug.target ?? "").trim().slice(0, 300);
}

export async function confirmFindings(
  page: Page,
  bugs: RunStep[],
  baseUrl: string,
  opts: { maxStepsPerFinding?: number; maxTotalSteps?: number; extraClaims?: string[] } = {},
): Promise<ConfirmationOutcome> {
  const candidates = bugs.filter((b) => claimOf(b).length > 0);
  // Failed checks are half of what a user sees and were previously published
  // without any second look. They are re-driven here alongside the findings.
  const extras = (opts.extraClaims ?? []).filter((c) => c.trim().length > 0);
  if (candidates.length === 0 && extras.length === 0) {
    return { kept: bugs, dropped: [], llmCalls: [], extraReproduced: extras.map(() => true) };
  }

  const allClaims = [...candidates.map(claimOf), ...extras];
  const claims = allClaims.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const perFinding = opts.maxStepsPerFinding ?? 5;
  const maxSteps = Math.min(opts.maxTotalSteps ?? 36, Math.max(8, allClaims.length * perFinding));
  // Blind re-check: the agent is given the AREA to inspect, never the claim.
  // Telling it what was previously reported makes it agree with itself, which
  // is why the primed version of this pass measured as having no effect at all.
  const questions = allClaims
    .map((c, i) => `${i + 1}. ${neutralQuestion(c)}`)
    .join("\n");
  const intent =
    `Work through the following observations one at a time. For each, carry out the interaction described and then report EXACTLY what appears on screen: the concrete value, message, count or state, quoted verbatim.\n\n` +
    `${questions}\n\n` +
    `Report only what you observe. Do not judge whether it is correct, and do not report problems — another step does that. If you cannot reach something, say so plainly rather than guessing.`;

  const llmCalls: LLMCallRecord[] = [];
  let trace: RunStep[] = [];
  try {
    const result = await runAgent(
      page, intent, baseUrl, null, [], undefined,
      undefined, undefined,
      (call) => llmCalls.push(call),
      undefined, undefined,
      maxSteps, baseUrl,
    );
    trace = result.stepsDetail ?? [];
  } catch (err) {
    // A failed confirmation pass must not silently delete findings.
    logger.warn({ err: String(err).slice(0, 200) }, "Finding confirmation pass failed — keeping all candidates");
    return { kept: bugs, dropped: [], llmCalls, extraReproduced: extras.map(() => true) };
  }

  // The blind pass answered questions; now compare those answers to the
  // original claims. Grading happens here rather than in the verification agent
  // because that agent grades a trace against an intent, and the intent
  // deliberately no longer contains the claims.
  const observed = trace
    .filter((st) => (st.observation ?? "").trim().length > 0)
    .map((st) => `[${st.index}] ${st.action}${st.target ? ` ${st.target}` : ""} -> ${String(st.observation).slice(0, 240)}`)
    .join("\n");

  const JUDGE = `You are given what an automated tester OBSERVED on a page, and a list of CLAIMS made earlier about that same page.

For each claim answer one of:
- "supported": the observations show the problem the claim describes.
- "refuted": the observations show the opposite — the thing the claim says is broken visibly works.
- "unclear": the observations do not cover it either way.

The observations are the only evidence. Do not reason about what the page probably does. Prefer "unclear" over guessing.

Return JSON only: {"verdicts":[{"index": number, "verdict": "supported"|"refuted"|"unclear"}]}`;

  let verdicts: Array<{ index: number; verdict: string }> = [];
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: (process.env.KERY_AUXILIARY_MODEL || "luna").replace(/^openai\//, ""),
        messages: [
          { role: "system", content: JUDGE },
          { role: "user", content: `OBSERVATIONS:\n${observed || "(none recorded)"}\n\nCLAIMS:\n${allClaims.map((c, i) => `${i}. ${c}`).join("\n")}` },
        ],
        max_completion_tokens: 1500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`judge ${res.status}`);
    const body = await res.json();
    verdicts = JSON.parse((body.choices?.[0]?.message?.content ?? "{}").replace(/^```(?:json)?|```$/g, "")).verdicts ?? [];
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Blind confirmation grading failed — keeping all candidates");
    return { kept: bugs, dropped: [], llmCalls, extraReproduced: extras.map(() => true) };
  }

  const verdictAt = (i: number) => verdicts.find((v) => v.index === i)?.verdict ?? "unclear";

  // Drop ONLY on positive refutation. "unclear" keeps the finding: a re-check
  // that never reached the surface is not evidence the problem is absent, and
  // treating it as such is what cost real detection earlier.
  const kept: RunStep[] = [];
  const dropped: RunStep[] = [];
  candidates.forEach((bug, i) => {
    if (verdictAt(i) === "refuted") dropped.push(bug);
    else kept.push(bug);
  });

  // Same rule for failed checks: keep unless the re-check positively refutes.
  const extraReproduced = extras.map((_, k) => verdictAt(candidates.length + k) !== "refuted");

  const untouched = bugs.filter((b) => !candidates.includes(b));
  logger.info(
    {
      candidates: candidates.length, kept: kept.length, dropped: dropped.length,
      failedChecks: extras.length, failedChecksDropped: extraReproduced.filter((r) => !r).length,
      steps: trace.length,
    },
    "Finding confirmation pass complete",
  );
  return { kept: [...kept, ...untouched], dropped, llmCalls, extraReproduced };
}
