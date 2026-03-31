/**
 * Post-run flow review: one vision+text call with full step trace and key page screenshots.
 * Finds functional, behavioral, and navigation issues (not single-frame pure visuals — use filmstrip for that).
 */
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";
import type { ReviewBug } from "./types.js";
import type { FilmstripFrame } from "./filmstripReview.js";

const MAX_FRAMES = 8;
const BASE_STEP_INDEX = 60_000;

const HOLISTIC_SYSTEM = `You are an expert QA flow reviewer. Another AI ("Navigator") drove a real browser to test a web app.

You receive:
1) The test intent (goal)
2) Whether the Navigator finished without crashing (passed vs failed run status)
3) A full step-by-step trace with:
   - actions taken and their reasoning
   - domChanged=yes/NO — whether the page DOM actually changed after the previous action. "domChanged=NO ⚠️" means the action had NO observable effect (stagnation).
   - interactive elements visible on the page at each step
4) Ordered screenshots capturing the page after each distinct DOM state change during the run. The LAST screenshot is the final page state when the run ended.

KEY ANALYSIS PATTERN:
- Compare what the Navigator CLAIMS happened (reasoning, doneResult) against the EVIDENCE (domChanged flags, visible elements, screenshots).
- When domChanged=NO after a click, the click likely had no effect — the Navigator may have hallucinated success.
- Check the final screenshot carefully: does it match the expected end state for the intent?
- Cross-reference element lists (e.g. buttons saying "Add to cart" vs "Remove") with the Navigator's claims about what was accomplished.

YOUR JOB — find REAL application defects in FUNCTION, BEHAVIOR, NAVIGATION, or INTENT GAPS:
- Silent failures: actions reported ok but domChanged=NO, repeated clicks on same control, or counts/state not updating
- Intent not met: e.g. user asked to add N items but element state or cart count shows fewer were actually added
- State inconsistency: Navigator claims success but elements/screenshots contradict it
- Do NOT report pure pixel/layout issues unless tied to a functional problem (a separate Visual agent handles cross-page visuals)

Rules:
- Automation overlays (green circles, numbered markers) are NOT bugs.
- The Navigator can hallucinate. Trust domChanged flags and element state over Navigator reasoning.

Return JSON only:
{ "bugs": [ { "type": "visual"|"ux"|"behavioral"|"a11y"|"performance"|"data", "description": string (max 120 chars), "severity": "high"|"medium"|"low", "frameIndex"?: number (0-based index into the screenshot list), "region"?: { "x": number, "y": number, "w": number, "h": number } } ] }
If none: { "bugs": [] }.
Use frameIndex to tie a bug to the screenshot that best shows the issue.`;

function buildTrace(stepsDetail: RunStep[]): string {
  const lines: string[] = [];
  let prevHash: string | undefined;
  for (const s of stepsDetail) {
    const obs = s.observation ? ` observation="${s.observation.slice(0, 120)}"` : "";
    const dr = s.doneResult ? ` doneResult=${s.doneResult}` : "";
    const domChanged =
      s.preActionDomHash != null && prevHash != null
        ? s.preActionDomHash !== prevHash
          ? " domChanged=yes"
          : " domChanged=NO ⚠️"
        : "";
    const dom = s.domContext
      ? ` elements=[${(s.domContext.match(/\[\d+\] \w+ "[^"]+"/g) ?? []).slice(0, 8).join(", ")}]`
      : "";
    lines.push(
      `- [${s.index}] ${s.action} ${s.target ?? ""} status=${s.status}${dr}${domChanged}${obs}${dom} ${(s.reasoning ?? "").slice(0, 200)}`,
    );
    if (s.preActionDomHash != null) prevHash = s.preActionDomHash;
  }
  return lines.join("\n");
}

function pickFrames(frames: FilmstripFrame[], max: number): FilmstripFrame[] {
  if (frames.length <= max) return [...frames];
  const out: FilmstripFrame[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / (max - 1)) * (frames.length - 1));
    out.push(frames[idx]!);
  }
  return out;
}

function parseHolisticResponse(
  raw: string,
  baseStepIndex: number,
  frames: FilmstripFrame[],
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
          : "behavioral";
      const severity = b.severity === "low" || b.severity === "medium" || b.severity === "high" ? b.severity : "medium";
      const fi =
        typeof b.frameIndex === "number" && b.frameIndex >= 0 && b.frameIndex < frames.length
          ? b.frameIndex
          : 0;
      const screenshotBase64 = frames[fi]?.base64 ?? frames[0]?.base64 ?? "";
      bugs.push({
        source: "review",
        stepIndex: baseStepIndex + i,
        type,
        description: (b.description ?? "").slice(0, 500),
        severity,
        region: b.region,
        at,
        screenshotBase64,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err), raw: raw?.slice(0, 200) }, "HolisticReview: failed to parse LLM response");
  }
  return bugs;
}

export type HolisticReviewInput = {
  intent: string;
  stepsDetail: RunStep[];
  frames: FilmstripFrame[];
  navigatorStatus: "passed" | "failed";
  networkSummary?: string;
};

export async function runHolisticFlowReview(
  input: HolisticReviewInput,
  opts?: { onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void },
): Promise<{ bugs: ReviewBug[] }> {
  const trace = buildTrace(input.stepsDetail);
  if (!trace.trim()) return { bugs: [] };

  const frames = pickFrames(input.frames, MAX_FRAMES);
  const config = getConfig();
  const model = config.reviewAgentModel;

  const textIntro =
    `Test intent: "${input.intent}"\n` +
    `Navigator run finished with status: ${input.navigatorStatus} (passed = Navigator called done or completed path; failed = error, blocked, or step limit).\n` +
    (input.networkSummary?.trim()
      ? `\nNetwork / API signals during actions:\n${input.networkSummary}\n`
      : "") +
    `\nFull step trace:\n${trace}\n\n` +
    (frames.length > 0
      ? `Screenshots below show the page after each distinct DOM state change (in order). The LAST screenshot (#${frames.length - 1}) is the final page state when the run ended.\n${frames.map((f, i) => `${i}. ${f.url}`).join("\n")}`
      : "No page screenshots available — rely on the trace only.");

  const userParts: unknown[] = [{ type: "text", text: textIntro }];
  for (const f of frames) {
    userParts.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${f.base64}`,
        detail: "auto",
      },
    });
  }

  const at = Date.now();
  const messages = [
    { role: "system", content: HOLISTIC_SYSTEM },
    { role: "user", content: userParts },
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
    opts?.onLLMCall?.({
      stepIndex: BASE_STEP_INDEX,
      model,
      hasVision: true,
      attempt: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens, "reviewAgentModel"),
      query: `Holistic flow review (${frames.length} screenshots)`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: raw,
      agent: "holistic",
    });
    const fallbackFrames = frames.length > 0 ? frames : [{ url: "", base64: "" }];
    return { bugs: parseHolisticResponse(raw, BASE_STEP_INDEX, fallbackFrames, at) };
  } catch (err) {
    logger.warn({ err: String(err) }, "HolisticReview: LLM call failed");
    return { bugs: [] };
  }
}
