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
- STRICT EVIDENCE BAR: "verified" requires an observed effect in the trace — a recorded observation, domChanged=yes with a matching effect, a navigation, or a concrete value. Treat the change description as a claim to check, not a fact.
- NAVIGATOR CLAIMS ARE NOT EVIDENCE: reasoning text like "verified X" or "confirmed Y" without a recorded observation, DOM change, or navigation does NOT support "verified". Cite only actions plus their observed effects.
- ATTEMPTED-BUT-SILENT IS CONTRADICTED: if the claim's action was directly performed and the trace shows no observed effect (domChanged=NO, no observation, no navigation), grade "contradicted" — silent controls are failures, not unknowns. Reserve "not_testable" for claims whose actions were never attempted (blocked or unreached).
- 2-6 claims. Prefer the claims a reviewer would need before merging.
- "evidence" is one sentence citing the step(s) or observation that decides the grade.

Return JSON only: {"verifications": [{"claim": string, "status": "verified"|"contradicted"|"not_testable", "evidence": string}]}
Output MUST be raw JSON only — no markdown fences, no prose.`;

function stripFence(raw: string): string {
  return raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export async function runVerificationReview(input: {
  intent: string;
  context?: string;
  stepsDetail: RunStep[];
  navigatorStatus: "passed" | "failed";
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
  const user =
    `Test intent: "${input.intent}"\n` +
    (input.context?.trim() ? `Change under test (background): ${input.context.trim()}\n` : "") +
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
      const parsed = JSON.parse(stripFence(raw ?? "")) as { verifications?: unknown };
      const list = Array.isArray(parsed.verifications) ? parsed.verifications : [];
      return list
        .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
        .map((v) => ({
          claim: String(v.claim ?? "").slice(0, 200),
          status: (["verified", "contradicted", "not_testable"].includes(String(v.status))
            ? String(v.status)
            : "not_testable") as RunVerification["status"],
          evidence: String(v.evidence ?? "").slice(0, 300),
        }))
        .filter((v) => v.claim)
        .slice(0, 6);
    } catch (err) {
      logger.warn({ err: String(err).split("\n")[0], attempt }, "Verification review parse failed");
    }
  }
  return [];
}
