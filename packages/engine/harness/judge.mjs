/**
 * Semantic scorer for the benchmark.
 *
 * Regex detection produced false negatives — the agent reported "the row order
 * remains GPT-4o mini" and the pattern list wanted "unchanged", so a real catch
 * scored zero. Since every conclusion depends on this number, scoring is done by
 * an LLM judge that reads the planted bug's description and the run's findings
 * and decides whether the run actually surfaced THAT defect.
 *
 * The judge is deliberately strict: describing the feature working, or flagging
 * an unrelated problem in the same area, does not count.
 */
const JUDGE_MODEL = process.env.KERY_JUDGE_MODEL || "terra";

const SYSTEM = `You score an automated browser test run against a KNOWN planted bug.

You are given the bug (what was deliberately broken in the code, and why it is wrong) and every finding/failed-check the run produced.

Answer for each bug: did the run actually surface THIS defect?

Rules:
- "caught" requires the run to describe the wrong BEHAVIOUR of this specific defect. It does not need to name the cause, the file, or use the same words.
- Reporting the affected area without the defect (e.g. "the discount field is confusing") is NOT caught.
- Reporting a DIFFERENT defect that happens to touch the same control is NOT caught.
- Stating the feature works correctly is NOT caught.
- Be strict and consistent: a false "caught" corrupts the benchmark more than a missed one.

Return JSON only: {"results":[{"id": string, "caught": boolean, "why": string}]}`;

export async function judgeCase(testCase, runResult, apiKey) {
  const findings = [
    ...(runResult.bugsFound ?? []).map((b) => b.reasoning ?? b.bugDescription ?? ""),
    ...(runResult.verifications ?? [])
      .filter((v) => v.status === "contradicted")
      .map((v) => `FAILED CHECK: ${v.claim} — ${v.evidence}`),
  ].filter(Boolean);

  // No findings at all: nothing could have been caught.
  if (findings.length === 0) {
    return testCase.plantedBugs.map((b) => ({ id: b.id, class: b.class, caught: false, why: "run produced no findings" }));
  }

  const user = [
    `PLANTED BUGS:`,
    ...testCase.plantedBugs.map((b) => `- id: ${b.id}\n  class: ${b.class}\n  what is broken: ${b.note}\n  expected user-visible symptom: ${b.symptom ?? "(infer from the above)"}`),
    ``,
    `RUN FINDINGS (${findings.length}):`,
    ...findings.map((f, i) => `${i + 1}. ${f}`),
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      max_completion_tokens: 2_000,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`judge failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body = await res.json();
  const parsed = JSON.parse((body.choices?.[0]?.message?.content ?? "{}").replace(/^```(?:json)?|```$/g, ""));
  const byId = new Map((parsed.results ?? []).map((r) => [r.id, r]));
  return testCase.plantedBugs.map((b) => {
    const v = byId.get(b.id);
    return { id: b.id, class: b.class, caught: Boolean(v?.caught), why: (v?.why ?? "judge gave no verdict").slice(0, 240) };
  });
}
