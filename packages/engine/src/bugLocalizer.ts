/**
 * Bug region localizer — the "second look" over a bug's already-captured
 * screenshot.
 *
 * Navigator-sourced bugs (and failed steps) carry a full-page screenshot but no
 * `region`, so their evidence image can only be the whole frame — the reader has
 * to hunt for the defect. Review/filmstrip/holistic bugs carry a region (the
 * vision reviewer read it off the grid overlay) and therefore zoom.
 *
 * This pass closes that gap WITHOUT re-driving the browser. It re-analyzes the
 * frames the run already captured — one batched vision call — and asks only
 * "where on this shot is the reported problem?". It never adds, removes, or
 * re-grades a bug, so it cannot change what the run detects; the worst case is a
 * null/invalid region, which leaves the bug exactly as it was (full-frame
 * fallback in renderIssueArtifact). That is the deliberate contrast with a live
 * re-screenshot / re-drive, which reproduces state-dependent defects
 * unreliably and has measured -16 pts of detection (see KERY_CONFIRM notes in
 * runOrchestrator).
 *
 * On by default; disable with KERY_LOCALIZE=0.
 */
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import { drawGridOnScreenshot } from "./gridScan.js";
import { parseFirstJsonObject } from "./jsonResponse.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import type { RunVerification } from "./verificationAgent.js";

const MAX_LOCALIZE = 12; // cap images per run; bugs keep priority when checks are present

function isEnabled(): boolean {
  return process.env.KERY_LOCALIZE !== "0";
}

/** A region is usable only if it sits inside the 0–1000 grid and has area. */
function validRegion(r: unknown): r is { x: number; y: number; w: number; h: number } {
  if (!r || typeof r !== "object") return false;
  const { x, y, w, h } = r as Record<string, unknown>;
  return (
    [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (x as number) >= 0 && (y as number) >= 0 &&
    (w as number) > 0 && (h as number) > 0 &&
    (x as number) + (w as number) <= 1000 &&
    (y as number) + (h as number) <= 1000 &&
    // Ignore a box that covers almost the whole frame — that's not a zoom,
    // it's the current full-shot behavior with extra cost.
    (w as number) * (h as number) < 1000 * 1000 * 0.85
  );
}

/** Short defect text the model needs to know what to look for. */
function bugText(b: RunStep): string {
  // Navigator bugs carry the defect in `reasoning`; `name`/`bugDescription` may
  // be present after enrichment. Read them loosely and fall back cleanly.
  const loose = b as Record<string, unknown>;
  const parts = [loose.name, loose.bugDescription, b.reasoning, b.assertion]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  // Dedupe repeats (name often prefixes reasoning) and cap length.
  const seen = new Set<string>();
  const uniq = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return uniq.join(" — ").slice(0, 400);
}

/** Short check text the model needs to know what to prove. */
function checkText(v: RunVerification): string {
  const parts = [
    v.status === "verified"
      ? "Verification item: box the specific visible element or area that proves this claim is true."
      : "Verification item: box the specific visible element or area that demonstrates this contradiction.",
    v.title ? `Title: ${v.title}` : "",
    `Claim: ${v.claim}`,
    v.evidence ? `Evidence: ${v.evidence}` : "",
  ].filter(Boolean);
  return parts.join(" ").slice(0, 500);
}

function hasInlineScreenshot(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && !/^\/api\/|^https?:/.test(s);
}

const SYSTEM = `You localize evidence within a screenshot.

You are given screenshots from an automated browser test, each with either a reported UI problem or a verification item. Another AI drove the browser, so green markers / numbered circles are automation overlays — never the problem or evidence, and never what you localize.

For reported problem items, return the tightest bounding box around the SPECIFIC element or area the reported problem is about — the miscounted label, the mis-rendered preview, the stale confirmation, the overflowing text — not the whole page and not a large region "to be safe".

For verification items, return the tightest bounding box around the SPECIFIC visible element or area that proves or contradicts the claim — the created row, the updated value, the success toast, the validation message, the stale value — not the whole page and not a large region "to be safe".

If you genuinely cannot tell where the problem or verification evidence is on that image, return null for it.

Coordinates use a 0–1000 scale relative to the screenshot: (0,0) top-left, (1000,1000) bottom-right; x and y are independently normalized to width and height. The images carry a faint 0–1000 grid — read the axis labels. Example: an element 90% across, 5% down, 5% wide, 8% tall → {"x":900,"y":50,"w":50,"h":80}.

Return raw JSON only, no markdown, no prose:
{"regions":[{"index":number,"region":{"x":number,"y":number,"w":number,"h":number}|null}]}
"index" is the 0-based position of the image in the batch.`;

type LocalizeCandidate = {
  screenshotBase64: string;
  text: string;
  target: { kind: "bug"; value: RunStep } | { kind: "check"; value: RunVerification };
};

function buildBugCandidates(bugs: RunStep[], limit: number): LocalizeCandidate[] {
  return bugs
    .filter((b) => b.action === "bug")
    .filter((b) => hasInlineScreenshot(b.screenshotBase64))
    .filter((b) => !validRegion(b.region))
    .map((b) => ({ bug: b, text: bugText(b) }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, limit)
    .map(({ bug, text }) => ({
      screenshotBase64: bug.screenshotBase64!,
      text: `Reported problem: ${text}`,
      target: { kind: "bug" as const, value: bug },
    }));
}

function buildCheckCandidates(verifications: RunVerification[], limit: number): LocalizeCandidate[] {
  return verifications
    .filter((v) => v.status === "verified" || v.status === "contradicted")
    .filter((v) => hasInlineScreenshot(v.screenshotBase64))
    .filter((v) => !validRegion(v.region))
    .map((v) => ({ verification: v, text: checkText(v) }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, limit)
    .map(({ verification, text }) => ({
      screenshotBase64: verification.screenshotBase64!,
      text,
      target: { kind: "check" as const, value: verification },
    }));
}

/**
 * Fill in `region` on bugs that have a screenshot but no region, using one
 * batched vision call over the existing frames. When verifications are passed,
 * check evidence joins the same batch after bugs. Mutates the passed records in
 * place; best-effort — any failure leaves records untouched.
 */
export async function localizeBugRegions(
  bugs: RunStep[],
  opts?: {
    verifications?: RunVerification[];
    onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void;
    /** Test hook for deterministic unit tests. */
    __test?: {
      llmChat?: typeof llmChat;
      drawGridOnScreenshot?: typeof drawGridOnScreenshot;
    };
  },
): Promise<{ localized: number; localizedBugs: number; localizedChecks: number }> {
  if (!isEnabled()) return { localized: 0, localizedBugs: 0, localizedChecks: 0 };

  const bugCandidates = buildBugCandidates(bugs, MAX_LOCALIZE);
  const checkCandidates = buildCheckCandidates(opts?.verifications ?? [], Math.max(0, MAX_LOCALIZE - bugCandidates.length));
  const candidates = [...bugCandidates, ...checkCandidates];

  if (candidates.length === 0) return { localized: 0, localizedBugs: 0, localizedChecks: 0 };

  const config = getConfig();
  const model = config.reviewAgentModel;
  const chat = opts?.__test?.llmChat ?? llmChat;
  const drawGrid = opts?.__test?.drawGridOnScreenshot ?? drawGridOnScreenshot;

  // Grid the frames so the model can read coordinates; keep originals untouched.
  const gridded = await Promise.all(
    candidates.map(async (c) => {
      try {
        return (await drawGrid(Buffer.from(c.screenshotBase64, "base64"))).toString("base64");
      } catch {
        return c.screenshotBase64;
      }
    }),
  );

  const content: any[] = [
    {
      type: "text",
      text:
        "Localize the requested problem or verification evidence in each screenshot below.\n" +
        candidates.map((c, i) => `Image ${i}: ${c.text}`).join("\n"),
    },
  ];
  for (const b64 of gridded) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "auto" } });
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content },
  ];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await chat(messages, model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeoutMs: config.reviewTimeoutMs * 2,
    });
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel");

    const parsed = parseFirstJsonObject<{
      regions?: Array<{ index?: number; region?: { x: number; y: number; w: number; h: number } | null }>;
    }>(raw ?? "");

    let localizedBugs = 0;
    let localizedChecks = 0;
    for (const entry of parsed?.regions ?? []) {
      const i = entry?.index;
      if (typeof i !== "number" || i < 0 || i >= candidates.length) continue;
      if (validRegion(entry.region)) {
        const candidate = candidates[i];
        candidate.target.value.region = entry.region!;
        if (candidate.target.kind === "bug") localizedBugs++;
        else localizedChecks++;
      }
    }
    const localized = localizedBugs + localizedChecks;

    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    opts?.onLLMCall?.({
      stepIndex: 60_000,
      model,
      hasVision: true,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd,
      query: `Evidence region localization (${candidates.length} frame${candidates.length === 1 ? "" : "s"})`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: raw,
      agent: "localizer",
    });

    logger.info({ candidates: candidates.length, localizedBugs, localizedChecks }, "Evidence localizer: attached regions");
    return { localized, localizedBugs, localizedChecks };
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Evidence localizer failed (non-fatal) — records left as-is");
    return { localized: 0, localizedBugs: 0, localizedChecks: 0 };
  }
}

export async function localizeCheckRegions(
  verifications: RunVerification[],
  opts?: Parameters<typeof localizeBugRegions>[1],
): Promise<{ localized: number; localizedBugs: number; localizedChecks: number }> {
  return localizeBugRegions([], { ...opts, verifications });
}
