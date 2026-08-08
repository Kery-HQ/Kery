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

const MAX_LOCALIZE = 8; // cap images per run; navigator bugs are usually few

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

const SYSTEM = `You localize a reported UI problem within a screenshot.

You are given screenshots from an automated browser test, each with a reported problem. Another AI drove the browser, so green markers / numbered circles are automation overlays — never the problem, and never what you localize.

For each image, return the tightest bounding box around the SPECIFIC element or area the reported problem is about — the miscounted label, the mis-rendered preview, the stale confirmation, the overflowing text — not the whole page and not a large region "to be safe". If you genuinely cannot tell where the problem is on that image, return null for it.

Coordinates use a 0–1000 scale relative to the screenshot: (0,0) top-left, (1000,1000) bottom-right; x and y are independently normalized to width and height. The images carry a faint 0–1000 grid — read the axis labels. Example: an element 90% across, 5% down, 5% wide, 8% tall → {"x":900,"y":50,"w":50,"h":80}.

Return raw JSON only, no markdown, no prose:
{"regions":[{"index":number,"region":{"x":number,"y":number,"w":number,"h":number}|null}]}
"index" is the 0-based position of the image in the batch.`;

/**
 * Fill in `region` on bugs that have a screenshot but no region, using one
 * batched vision call over the existing frames. Mutates the passed bugs in
 * place; best-effort — any failure leaves bugs untouched.
 */
export async function localizeBugRegions(
  bugs: RunStep[],
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<{ localized: number }> {
  if (!isEnabled()) return { localized: 0 };

  // Candidates: a real screenshot, no usable region yet, and something to look for.
  const candidates = bugs
    .filter((b) => b.action === "bug")
    .filter((b) => typeof b.screenshotBase64 === "string" && b.screenshotBase64.length > 0)
    .filter((b) => b.screenshotBase64!.length > 0 && !/^\/api\/|^https?:/.test(b.screenshotBase64!))
    .filter((b) => !validRegion(b.region))
    .filter((b) => bugText(b).length > 0)
    .slice(0, MAX_LOCALIZE);

  if (candidates.length === 0) return { localized: 0 };

  const config = getConfig();
  const model = config.reviewAgentModel;

  // Grid the frames so the model can read coordinates; keep originals untouched.
  const gridded = await Promise.all(
    candidates.map(async (b) => {
      try {
        return (await drawGridOnScreenshot(Buffer.from(b.screenshotBase64!, "base64"))).toString("base64");
      } catch {
        return b.screenshotBase64!;
      }
    }),
  );

  const content: any[] = [
    {
      type: "text",
      text:
        "Localize the reported problem in each screenshot below.\n" +
        candidates.map((b, i) => `Image ${i}: ${bugText(b)}`).join("\n"),
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
    const { content: raw, usage } = await llmChat(messages, model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeoutMs: config.reviewTimeoutMs * 2,
    });
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel");

    const parsed = parseFirstJsonObject<{
      regions?: Array<{ index?: number; region?: { x: number; y: number; w: number; h: number } | null }>;
    }>(raw ?? "");

    let localized = 0;
    for (const entry of parsed?.regions ?? []) {
      const i = entry?.index;
      if (typeof i !== "number" || i < 0 || i >= candidates.length) continue;
      if (validRegion(entry.region)) {
        candidates[i].region = entry.region!;
        localized++;
      }
    }

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
      query: `Bug region localization (${candidates.length} frame${candidates.length === 1 ? "" : "s"})`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: raw,
      agent: "localizer",
    });

    logger.info({ candidates: candidates.length, localized }, "Bug localizer: attached regions");
    return { localized };
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Bug localizer failed (non-fatal) — bugs left as-is");
    return { localized: 0 };
  }
}
