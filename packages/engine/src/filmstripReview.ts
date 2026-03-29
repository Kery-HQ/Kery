/**
 * Post-run journey review: analyzes ordered page screenshots (one per unique URL)
 * for cross-page consistency and flow issues. Complements per-step Review Agent.
 */
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { LLMCallRecord } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { ReviewBug } from "./types.js";

export type FilmstripFrame = { url: string; base64: string };

const CHUNK_SIZE = 12;
const MAX_FRAMES = 30;

const FILMSTRIP_SYSTEM = `You are an expert QA agent reviewing an ORDERED sequence of screenshots from a single automated test run. Each image is the first view after navigating to a distinct URL (one frame per page).

IMPORTANT: Another AI drove the browser. Automation overlays (green markers, numbered circles) are NOT app bugs if visible — ignore them.

YOUR JOB: Find issues that only make sense ACROSS the journey or when comparing pages:
- Inconsistent typography, spacing, or component styling between routes (e.g. button sizes, header layout)
- Navigation or IA that feels broken across steps (e.g. misleading breadcrumbs, dead-end flows)
- Branding or layout regressions between pages (different nav height, logo treatment)
- Data or state that should reset between pages but appears to leak incorrectly (when visible across frames)
- Accessibility patterns that break only in multi-page context (e.g. focus order implied by flow)

Do NOT report issues that are clearly about a single static frame only — the per-step reviewer already handles those.
Do NOT blame the automation driver for wrong clicks.

Return JSON: { "bugs": [ { "type": "visual"|"ux"|"behavioral"|"a11y"|"performance"|"data", "description": string (max 100 chars), "severity": "low"|"medium"|"high", "frameIndex"?: number (0-based index within THIS batch of images), "region"?: { "x": number, "y": number, "w": number, "h": number } } ] }
If none: { "bugs": [] }.
Be selective. 0 bugs is fine.`;

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
  defaultScreenshot: string,
  at: number,
): ReviewBug[] {
  const bugs: ReviewBug[] = [];
  const toParse = raw?.trim() ?? "";
  if (!toParse) return bugs;
  try {
    let body = toParse;
    const jsonMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) body = jsonMatch[1].trim();
    if (!body.endsWith("}") && body.includes('"bugs"')) {
      const lastObjEnd = body.lastIndexOf("},");
      if (lastObjEnd > 0) body = body.slice(0, lastObjEnd + 1) + "]}";
    }
    const parsed = JSON.parse(body) as {
      bugs?: Array<{
        type?: string;
        description?: string;
        severity?: string;
        frameIndex?: number;
        region?: { x: number; y: number; w: number; h: number };
      }>;
    };
    const list = Array.isArray(parsed?.bugs) ? parsed.bugs : [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const t = (b.type ?? "").trim();
      const type: ReviewBug["type"] =
        t === "visual" || t === "ux" || t === "behavioral" || t === "a11y" || t === "performance" || t === "data"
          ? t
          : "visual";
      const severity = b.severity === "low" || b.severity === "medium" || b.severity === "high" ? b.severity : "medium";
      const stepIndex = baseStepIndex + i;
      bugs.push({
        source: "filmstrip",
        stepIndex,
        type,
        description: (b.description ?? "").slice(0, 500),
        severity,
        region: b.region,
        at,
        screenshotBase64: defaultScreenshot,
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
  onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void,
): Promise<ReviewBug[]> {
  const config = getConfig();
  const model = config.reviewAgentModel;
  const baseStepIndex = 50_000 + chunkIndex * 1_000;
  const defaultScreenshot = chunk[0]?.base64 ?? "";

  const textIntro =
    `Batch ${chunkIndex + 1}. Images are in visit order (earlier = earlier in the test). ` +
    `URLs in order:\n${chunk.map((f, i) => `${i}. ${f.url}`).join("\n")}`;

  const content: any[] = [{ type: "text", text: textIntro }];
  for (const f of chunk) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${f.base64}`,
        detail: "auto",
      },
    });
  }

  const at = Date.now();
  const messages = [
    { role: "system", content: FILMSTRIP_SYSTEM },
    { role: "user", content },
  ];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(messages, model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.15,
      timeoutMs: config.reviewTimeoutMs * 2,
    });
    const durationMs = Date.now() - t0;
    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    onLLMCall?.({
      stepIndex: baseStepIndex,
      model,
      hasVision: true,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens),
      query: `Filmstrip journey review (chunk ${chunkIndex + 1}, ${chunk.length} frames)`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: raw,
      agent: "filmstrip",
    });
    return parseFilmstripResponse(raw, baseStepIndex, defaultScreenshot, at);
  } catch (err) {
    logger.warn({ err: String(err), chunkIndex }, "FilmstripReview: LLM call failed");
    return [];
  }
}

export async function runFilmstripReview(
  frames: FilmstripFrame[],
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<{ bugs: ReviewBug[] }> {
  const capped = capFilmstripFrames(frames);
  if (capped.length < 2) return { bugs: [] };

  const chunks = chunkFrames(capped, CHUNK_SIZE);
  const allBugs: ReviewBug[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkBugs = await analyzeChunk(chunks[i]!, i, opts?.onLLMCall);
    allBugs.push(...chunkBugs);
  }
  return { bugs: allBugs };
}
