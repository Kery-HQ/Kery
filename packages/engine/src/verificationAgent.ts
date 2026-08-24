import { llmChat, calcCostUsd } from "./llmClient.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import type { LLMCallRecord, RunStep } from "./agent.js";

/**
 * Verification reviewer: turns a finished run into an evidence record.
 *
 * The PR report's primary job is to PROVE the change under test works — with
 * concrete run evidence — and only secondarily to list bugs found around it.
 * This pass derives 2-6 plain-language claims from the intent/background and
 * grades each strictly against the step trace.
 */
export type RunVerification = {
  claim: string;
  status: "verified" | "contradicted" | "not_testable";
  evidence: string;
  /** A 2–5 word label for the check, e.g. "Deleting a task". Used as the
   *  scannable row in the PR comment; the full claim stays as the detail. */
  title?: string;
  /** The [n] step whose observation decides this check. For verified checks,
   *  use the after-state that proves the claim; for contradicted checks, use
   *  the screen where the wrong value or missing effect is visible. */
  stepIndex?: number;
  /** Evidence carriers are attached after review; the LLM only sets stepIndex. */
  screenshotBase64?: string;
  screenshotPath?: string;
  region?: { x: number; y: number; w: number; h: number };
  artifactKey?: string;
  /** For contradicted checks: the shortest sequence a human can follow to see
   *  the failure themselves. A reviewer cannot act on "expected X, got Y"
   *  alone; they can act on three numbered steps. */
  reproSteps?: string[];
  /** For contradicted checks: paths from the change under test that most
   *  likely cause this failure. Only ever a subset of the files supplied to
   *  the reviewer — never invented — and always a hint, not a diagnosis. */
  suspectFiles?: string[];
};

const VERIFICATION_SYSTEM = `You are a verification reviewer for an AI browser-testing run.

You receive the test intent, background on the change under test, and the full step trace (actions, reasoning, domChanged flags).

Produce the EVIDENCE RECORD for this run: a short list of concrete, user-facing claims about the change under test, each graded against the trace.

Grades:
- "verified": the trace shows the behavior demonstrably working — an action was taken AND its expected effect was observed (navigation happened, state changed, value appeared). Cite that evidence.
- "contradicted": the trace shows the behavior demonstrably NOT working (bugs are reported separately — still record the contradiction here).
- "not_testable": the run never exercised this claim (blocked, unreached, or out of scope). Say why.

Rules:
- Derive claims from the intent and change background, phrased as plain user-facing outcomes ("Clicking X opens Y", "The total updates when quantity changes").
- CLAIMS ARE INVARIANTS, NOT NARRATIVE: assert user-facing correctness (data complete, values accurate, actions produce their effect, navigation reaches the right place). When the change reformats, simplifies, or reorders displayed data, include a claim that no information was lost or corrupted — regardless of how the description frames the change.
- BEFORE→AFTER DELTAS: when the intent or background states a prior value (a count, a format that included a field, an ordering), compare the observed value against that BEFORE value. Observing the reduced/stripped state and calling it expected is wrong — silent loss of information grades "contradicted".
- DERIVED VALUES MUST RECONCILE: when a claim covers a displayed derived value (a total, rate, count, or ranking), recompute it from the underlying data recorded elsewhere in the trace and grade a mismatch "contradicted". If the underlying data was never visited, grade "not_testable" and say which surface would prove it — never verify a derived number on its own say-so.
- STRICT EVIDENCE BAR: "verified" requires an observed effect in the trace — a recorded observation, domChanged=yes with a matching effect, a navigation, or a concrete value. Treat the change description as a claim to check, not a fact.
- NAVIGATOR CLAIMS ARE NOT EVIDENCE: reasoning text like "verified X" or "confirmed Y" without a recorded observation, DOM change, or navigation does NOT support "verified". Cite only actions plus their observed effects.
- ABSENCE NEEDS PROOF OF LOOKING: before grading a claim "contradicted" because something did NOT appear — no error, no confirmation, no disabled state, no discount applied — the trace must show the agent looked in the right place AFTER the action and recorded what it saw instead. "I did not see it" is not "it was not there". Where the trace DOES record what was on screen instead — a count that did not change, a field still holding its old value, a list still showing the same rows — that is exactly the evidence needed and the claim should be graded "contradicted". Only when no such observation exists should this be "not_testable"; say what would have proved it.
- BRIEF STATES — TIMING DECIDES: a spinner, a disabled button, a "Saving"/"Processing" label or a toast exists only for a moment. If the trace shows the observation was taken immediately after triggering and the state was absent, grade "contradicted" — a missing progress indicator is a real defect. If the only observation came after the operation had already finished, grade "not_testable", not absent.
- ATTEMPTED-BUT-SILENT IS CONTRADICTED: if the claim's action was directly performed and the trace shows no observed effect (domChanged=NO, no observation, no navigation), grade "contradicted" — silent controls are failures, not unknowns. Reserve "not_testable" for claims whose actions were never attempted (blocked or unreached).
- 2-6 claims. Prefer the claims a reviewer would need before merging.
- "evidence" is one sentence citing the step(s) or observation that decides the grade.
- "title" is a 2-5 word label naming the behavior as a feature, not a sentence: "Deleting a task", "Promo code discount", "Checkout validation". No trailing punctuation. It is the scannable row a reviewer reads first; the claim carries the full assertion.
- For every "verified" check, add "stepIndex": the [n] index of the step whose observation shows the claim holding. Choose the AFTER-STATE screen that proves the effect, not the step that merely performed the action.
- For every "contradicted" check, add "stepIndex": the [n] index of the step whose observation shows the failure (the screen where the wrong value / missing effect is visible).
- Omit "stepIndex" for "not_testable" checks and whenever no single step pinpoints the evidence.
- For every "contradicted" check, add "reproSteps": 2-4 imperative steps a human can follow to see the failure, derived ONLY from what the trace actually did. Start from a stated entry point ("Open the editor"), name controls as they appear on screen, and make the last step the observation ("Look at the canvas — the image appears twice"). No preamble, no explanation, one action per step. Omit for verified and not_testable checks.
- When a CHANGED FILES list is supplied, add "suspectFiles" to every "contradicted" check: 1-3 paths COPIED EXACTLY from that list which most plausibly cause this specific failure, most likely first. Match on what the file evidently governs versus what broke. If nothing in the list plausibly relates, omit "suspectFiles" — a wrong pointer is worse than none. NEVER invent a path that is not in the supplied list.

Return JSON only: {"verifications": [{"title": string, "claim": string, "status": "verified"|"contradicted"|"not_testable", "evidence": string, "stepIndex"?: number, "reproSteps"?: string[], "suspectFiles"?: string[]}]}
Output MUST be raw JSON only — no markdown fences, no prose.`;

function stripFence(raw: string): string {
  return raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export async function runVerificationReview(input: {
  intent: string;
  context?: string;
  stepsDetail: RunStep[];
  navigatorStatus: "passed" | "failed";
  /** Paths touched by the change under test. Supplied by callers that know the
   *  diff (CI); when present the reviewer may point a failing check at the
   *  file most likely responsible. */
  changedFiles?: string[];
  onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void;
}): Promise<RunVerification[]> {
  let prevHash: string | undefined;
  const trace = input.stepsDetail
    .map((s) => {
      const parts = [`[${s.index}] ${s.action}`];
      if (s.target) parts.push(`target=${String(s.target).slice(0, 120)}`);
      if (s.status) parts.push(`status=${s.status}`);
      if (s.preActionDomHash != null && prevHash != null) {
        parts.push(s.preActionDomHash !== prevHash ? "domChanged=yes" : "domChanged=NO ⚠️");
      }
      if (s.preActionDomHash != null) prevHash = s.preActionDomHash;
      if (s.observation) parts.push(`observation="${String(s.observation).slice(0, 160)}"`);
      if (s.reasoning) parts.push(`— ${String(s.reasoning).slice(0, 200)}`);
      return parts.join(" ");
    })
    .join("\n");
  if (!trace.trim()) return [];

  const config = getConfig();
  const model = config.reviewAgentModel;
  // Cap the file list: long diffs would crowd out the trace, and the reviewer
  // only needs enough candidates to point at the likely one.
  const changed = (input.changedFiles ?? []).filter((f) => typeof f === "string" && f.trim()).slice(0, 40);
  const user =
    `Test intent: "${input.intent}"\n` +
    (input.context?.trim() ? `Change under test (background): ${input.context.trim()}\n` : "") +
    (changed.length ? `Changed files in this change:\n${changed.map((f) => `- ${f}`).join("\n")}\n` : "") +
    `Navigator finished with status: ${input.navigatorStatus}.\n\nStep trace:\n${trace}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t0 = Date.now();
      const messages = [
        { role: "system", content: VERIFICATION_SYSTEM },
        { role: "user", content: attempt === 0 ? user : `${user}\n\nREMINDER: raw JSON object only.` },
      ];
      const { content: raw, usage } = await llmChat(messages, model, {
        temperature: 0.1,
        timeoutMs: getConfig().reviewTimeoutMs,
      });
      input.onLLMCall?.({
        stepIndex: -1,
        model,
        hasVision: false,
        attempt: attempt + 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - t0,
        costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel"),
        query: "Verification review (evidence record)",
        response: raw,
        agent: "verification",
      } as never);
      return parseVerificationReview(raw ?? "", changed);
    } catch (err) {
      logger.warn({ err: String(err).split("\n")[0], attempt }, "Verification review parse failed");
    }
  }
  return [];
}

function parseStringList(value: unknown, max: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().replace(/\s+/g, " ").slice(0, maxLen))
    .slice(0, max);
  return out.length ? out : undefined;
}

/**
 * @param allowedFiles when supplied, `suspectFiles` is filtered to this set.
 * The model is told to copy paths verbatim, but a hallucinated path in a PR
 * comment sends a maintainer to a file that does not exist, so it is enforced
 * here rather than trusted. Matching is exact, then by basename, so a model
 * that shortens `a/b/Foo.tsx` to `Foo.tsx` still resolves.
 */
export function parseVerificationReview(raw: string, allowedFiles?: string[]): RunVerification[] {
  const parsed = JSON.parse(stripFence(raw ?? "")) as { verifications?: unknown };
  const list = Array.isArray(parsed.verifications) ? parsed.verifications : [];
  const allowed = allowedFiles?.length ? allowedFiles : null;
  const byBasename = new Map<string, string>();
  for (const f of allowed ?? []) byBasename.set(f.split("/").pop() ?? f, f);
  const resolveFile = (candidate: string): string | null => {
    if (!allowed) return null;
    if (allowed.includes(candidate)) return candidate;
    return byBasename.get(candidate.split("/").pop() ?? candidate) ?? null;
  };

  return list
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => {
      const status = (["verified", "contradicted", "not_testable"].includes(String(v.status))
        ? String(v.status)
        : "not_testable") as RunVerification["status"];
      // Repro steps and file pointers only mean anything for a failure.
      const repro = status === "contradicted" ? parseStringList(v.reproSteps, 4, 160) : undefined;
      const suspectRaw = status === "contradicted" ? parseStringList(v.suspectFiles, 3, 200) : undefined;
      const suspect = suspectRaw
        ? Array.from(new Set(suspectRaw.map(resolveFile).filter((f): f is string => !!f)))
        : undefined;
      return {
        claim: String(v.claim ?? "").slice(0, 200),
        status,
        evidence: String(v.evidence ?? "").slice(0, 300),
        title: v.title ? String(v.title).slice(0, 60) : undefined,
        stepIndex: typeof v.stepIndex === "number" && Number.isFinite(v.stepIndex) ? v.stepIndex : undefined,
        reproSteps: repro,
        suspectFiles: suspect?.length ? suspect : undefined,
      };
    })
    .filter((v) => v.claim)
    .slice(0, 6);
}
