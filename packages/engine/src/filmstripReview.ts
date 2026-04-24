/**
 * Post-run journey review: analyzes ordered page screenshots (one per unique URL)
 * for cross-page consistency and flow issues. Complements per-step Review Agent.
 */
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS, getReviewBugsResponseFormat } from "./llmClient.js";
import type { LLMCallRecord } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { ReviewBug } from "./types.js";
import { drawGridOnScreenshot } from "./gridScan.js";
import { parseFirstJsonObject } from "./jsonResponse.js";

export type FilmstripFrame = { url: string; base64: string };

const CHUNK_SIZE = 12;
const MAX_FRAMES = 30;

const FILMSTRIP_SYSTEM = `You are an expert QA agent reviewing an ORDERED sequence of screenshots from a single automated test run. Each image captures the page after a distinct visual state change during the test.

IMPORTANT: Another AI drove the browser. Automation overlays (green markers, numbered circles) are NOT app bugs if visible — ignore them.

YOUR JOB — visual quality across the journey:
- Broken or malformed components: overlapping elements, clipped text, images that failed to load, components that are clearly rendering incorrectly
- Uneven or broken spacing and alignment: misaligned buttons, inconsistent padding, elements that are out of place relative to their surroundings
- Inconsistent typography, spacing, or component styling between pages (e.g. button sizes differ across routes, header layout shifts)
- Branding or layout regressions between pages (nav bar changes height, logo treatment differs, colour scheme inconsistent)
- Navigation or information architecture that looks broken when comparing pages (misleading breadcrumbs, dead-end flows visible in screenshots)
- State visible in screenshots that should have reset between pages but appears to carry over

STRICT SCOPE — do NOT report these (other agents handle them):
- Functional failures: clicks that did nothing, forms that did not submit, counts that did not update — you do not have the action trace; the flow reviewer does
- Performance, network, or data correctness issues
- Blame the automation driver for navigating incorrectly

Return JSON: { "bugs": [ { "type": "visual"|"ux", "description": string (max 120 chars), "severity": "low"|"medium"|"high", "frameIndex"?: number (0-based index within THIS batch of images), "region"?: { "x": number, "y": number, "w": number, "h": number } } ] }
If none: { "bugs": [] }.
Be selective — only report what you are confident is a cross-page inconsistency.
Output MUST be raw JSON only. Do not use markdown fences. Do not add any prose.
If you include "region", coordinates MUST use a 0–1000 scale relative to the screenshot dimensions: (0,0) is top-left, (1000,1000) is bottom-right. x and y are independently normalized to image width and height — do NOT use raw viewport pixel values. Example: an element at 90% across and 5% down with width 5% and height 8% → {"x":900,"y":50,"w":50,"h":80}.
Screenshots have a faint 0-1000 coordinate grid overlay — read axis labels along the top and left edges to produce precise "region" values.`;

function chunkFrames(frames: FilmstripFrame[], size: number): FilmstripFrame[][] {
  const out: FilmstripFrame[][] = [];
  for (let i = 0; i < frames.length; i += size) {
    out.push(frames.slice(i, i + size));
  }
  return out;
}

/** Cap frame list for memory; keep head and tail coverage */
export function capFilmstripFrames(frames: FilmstripFrame[]): FilmstripFrame[] {
  if (frames.length <= MAX_FRAMES) return frames;
  const stride = frames.length / MAX_FRAMES;
  const out: FilmstripFrame[] = [];
  for (let i = 0; i < MAX_FRAMES; i++) {
    const idx = Math.min(Math.floor(i * stride), frames.length - 1);
    out.push(frames[idx]);
  }
  return out;
}

function parseFilmstripResponse(
  raw: string,
  baseStepIndex: number,
  chunk: FilmstripFrame[],
  at: number,
): ReviewBug[] {
  const bugs: ReviewBug[] = [];
  const toParse = raw?.trim() ?? "";
  if (!toParse) return bugs;
  try {
    const parsed = parseFirstJsonObject<{
      bugs?: Array<{
        type?: string;
        description?: string;
        severity?: string;
        frameIndex?: number;
        region?: { x: number; y: number; w: number; h: number };
      }>;
    }>(toParse);
    if (!parsed) return bugs;
    const list = Array.isArray(parsed?.bugs) ? parsed.bugs : [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const t = (b.type ?? "").trim();
      const type: ReviewBug["type"] =
        t === "visual" || t === "ux"
          ? t
          : "visual";
      const severity = b.severity === "low" || b.severity === "medium" || b.severity === "high" ? b.severity : "medium";
      const stepIndex = baseStepIndex + i;
      const fi =
        typeof b.frameIndex === "number" && b.frameIndex >= 0 && b.frameIndex < chunk.length
          ? b.frameIndex
          : 0;
      const screenshotBase64 = chunk[fi]?.base64 ?? chunk[0]?.base64 ?? "";
      bugs.push({
        source: "filmstrip",
        stepIndex,
        type,
        description: (b.description ?? "").slice(0, 500),
        severity,
        region: b.region,
        at,
        screenshotBase64,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err), raw: raw?.slice(0, 200) }, "FilmstripReview: failed to parse LLM response");
  }
  return bugs;
}

async function analyzeChunk(
  chunk: FilmstripFrame[],
  chunkIndex: number,
  intent: string | undefined,
  navigatorStatus: "passed" | "failed" | undefined,
  onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void,
): Promise<ReviewBug[]> {
  const config = getConfig();
  const model = config.reviewAgentModel;
  const baseStepIndex = 50_000 + chunkIndex * 1_000;

  const intentLine = intent
    ? `Test goal: "${intent}" — Navigator finished: ${navigatorStatus ?? "unknown"}.\n`
    : "";
  const textIntro =
    intentLine +
    `Batch ${chunkIndex + 1}. Images are in visit order (earlier = earlier in the test). ` +
    `Pages in order (one screenshot per distinct visual state):\n${chunk.map((f, i) => `${i}. ${f.url}`).join("\n")}`;

  // Grid the images for LLM input so it can read precise coordinates.
  // The clean originals in `chunk` are kept for bug screenshotBase64 storage.
  const griddedBase64s = await Promise.all(
    chunk.map(async (f) => {
      if (!f.base64) return f.base64;
      try {
        const buf = await drawGridOnScreenshot(Buffer.from(f.base64, "base64"));
        return buf.toString("base64");
      } catch {
        return f.base64;
      }
    }),
  );

  const content: any[] = [{ type: "text", text: textIntro }];
  for (const b64 of griddedBase64s) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${b64}`,
        detail: "auto",
      },
    });
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const at = Date.now();
  const messages = [
    { role: "system", content: `Current date/time: ${now}\n\n${FILMSTRIP_SYSTEM}` },
    { role: "user", content },
  ];

  const FILMSTRIP_BUG_TYPES = ["visual", "ux"];
  const responseFormat = getReviewBugsResponseFormat(model, FILMSTRIP_BUG_TYPES);

  try {
    const reminder = "REMINDER: Reply with one raw JSON object only. No markdown, no extra text.";
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const callMessages = attempt === 0
        ? messages
        : [
            messages[0],
            {
              role: "user" as const,
              content: [
                ...content,
                { type: "text", text: reminder },
              ],
            },
          ];
      const t0 = Date.now();
      const { content: raw, usage } = await llmChat(callMessages, model, {
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.15,
        timeoutMs: config.reviewTimeoutMs * 2,
        responseFormat,
      });
      const durationMs = Date.now() - t0;
      const attemptCost = calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel");
      totalCostUsd += attemptCost;
      totalDurationMs += durationMs;

      const parsed = parseFilmstripResponse(raw, baseStepIndex, chunk, at);
      const valid = parsed.length > 0 || parseFirstJsonObject<{ bugs?: unknown[] }>(raw) !== null;

      if (valid || attempt === 2) {
        const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(callMessages);
        onLLMCall?.({
          stepIndex: baseStepIndex,
          model,
          hasVision: true,
          attempt: attempt + 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          durationMs: totalDurationMs,
          costUsd: totalCostUsd,
          query: `Filmstrip journey review (chunk ${chunkIndex + 1}, ${chunk.length} frames)`,
          requestMessages,
          imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
          imageBase64: imageBase64s[0],
          response: raw,
          agent: "filmstrip",
        });
        return valid ? parsed : [];
      }
    }
    return [];
  } catch (err) {
    logger.warn({ err: String(err), chunkIndex }, "FilmstripReview: LLM call failed");
    return [];
  }
}

export async function runFilmstripReview(
  frames: FilmstripFrame[],
  opts?: {
    onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void;
    intent?: string;
    navigatorStatus?: "passed" | "failed";
  },
): Promise<{ bugs: ReviewBug[] }> {
  const capped = capFilmstripFrames(frames);
  if (capped.length < 2) return { bugs: [] };

  const chunks = chunkFrames(capped, CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk, i) =>
      analyzeChunk(chunk, i, opts?.intent, opts?.navigatorStatus, opts?.onLLMCall),
    ),
  );
  return { bugs: chunkResults.flat() };
}
