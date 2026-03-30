import type { ReviewBug } from "./types.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { LLMCallRecord } from "./agent.js";
import { serializeWireMessagesForStorage } from "./agent.js";

export type ReviewRequest = {
  screenshot: Buffer;
  url: string;
  title: string;
  stepIndex: number;
  action: string;
  actionResult: string;
  expectation?: string;
  previousUrl?: string;
  clickedElement?: string;
  coordinates?: { x: number; y: number };
  /** First paint after navigation or initial load — prefer keeping these when queue overflows */
  isNavigationBoundary: boolean;
};

const SYSTEM_PROMPT = `You are an expert QA review agent analyzing screenshots of a web application under automated testing.

IMPORTANT CONTEXT: Another AI agent (the "Navigator") is driving the browser. You are reviewing what the Navigator sees. The Navigator sometimes makes mistakes — clicking wrong elements, misidentifying buttons, getting stuck in loops. These are NOT bugs in the application.

YOUR JOB: Find REAL bugs in the APPLICATION, not problems caused by the Navigator.

## Visual checklist (look for these on THIS screenshot):
- Alignment and grid: misaligned columns, uneven spacing, elements breaking a clear layout rhythm
- Text: truncation with ellipsis where it hides meaning, overflow/clipping, overlapping text
- Images/icons: broken images, wrong aspect ratio, icons clipped or mis-sized
- Stacking: modals/dropdowns behind other layers, overlapping interactive controls
- Components: buttons/inputs inconsistent height or padding vs neighbors
- Contrast: text hard to read on background (accessibility)
- When you report a visual bug, include a \`region\` object: { x, y, w, h } as approximate 0-1000 normalized box on the image (or pixel coords if clearer)

## What IS a bug (report these):
- Visual defects: overlapping elements, broken layouts, truncated text, broken images, z-index issues
- Real UX issues: misleading error messages, confusing states that a human would also find confusing
- Data integrity: duplicate entries that shouldn't exist, incorrect data display
- Broken features: buttons/forms that genuinely don't work for a human user

## What is NOT a bug (DO NOT report these):
- IGNORE any green numbered circles, green bounding box outlines, or numbered markers overlaid on the page — these are test automation overlays, NOT part of the application
- The Navigator's action failed (timeout, element not found) — that's a Navigator issue, not an app bug
- The Navigator clicked the wrong button — not an app bug
- The Navigator is confused about what happened — not an app bug
- A button is disabled and the Navigator tried to click it — the app is correctly disabling it
- The Navigator went back and tried again — that's Navigator recovery, not an app bug
- Expected page transitions after navigation — not a bug
- Pre-filled form fields with default/previous values — usually expected behavior
- The same issue you already reported in a previous step — don't repeat it

## Key principle:
Ask yourself: "Would a knowledgeable human user, doing this same task, consider this a bug?"
If the answer is "no, this is just the automation struggling," return NO bugs.

## Additional bug categories to watch for:
- Accessibility (a11y): missing alt text on images, form inputs without labels, poor color contrast
- Performance: visible layout shifts, content jumping after load, slow-loading placeholders still visible
- Data integrity: wrong counts or totals, duplicate entries, mismatched data between sections

## Response format:
Return a JSON object with a "bugs" array. Each bug: { type: "visual" | "ux" | "behavioral" | "a11y" | "performance" | "data", description: string (max 80 chars), severity: "low" | "medium" | "high", region?: { x: number, y: number, w: number, h: number } }.
If no bugs found, return { "bugs": [] }.

Be VERY selective. 0 bugs is a perfectly good answer. Only report issues you're confident about.`;

function buildUserMessage(req: ReviewRequest, recentBugDescriptions: string[]): any[] {
  const parts: string[] = [
    `URL: ${req.url}`,
    `Page title: "${req.title}"`,
    `Step: ${req.stepIndex}`,
    `Navigator action: ${req.action}`,
    `Action result: ${req.actionResult}`,
  ];
  if (req.expectation) parts.push(`Navigator's expected outcome: ${req.expectation}`);
  if (req.previousUrl && req.previousUrl !== req.url) parts.push(`Previous URL: ${req.previousUrl}`);

  if (req.actionResult === "failed") {
    parts.push(`\nNOTE: The Navigator's action FAILED. This is likely a Navigator issue (wrong element, timeout, etc.), NOT an app bug. Only report a bug if the screenshot shows a genuine application problem independent of the failed action.`);
  }

  if (recentBugDescriptions.length > 0) {
    parts.push(`\nBugs already reported (DO NOT repeat these):\n${recentBugDescriptions.map(d => `- ${d}`).join("\n")}`);
  }

  const content: any[] = [{ type: "text", text: parts.join("\n") }];
  if (req.screenshot.length > 0) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${req.screenshot.toString("base64")}`,
        detail: "auto",
      },
    });
  }
  return content;
}

function parseReviewResponse(raw: string, stepIndex: number, at: number): ReviewBug[] {
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
    const parsed = JSON.parse(body) as { bugs?: Array<{ type?: string; description?: string; severity?: string; region?: { x: number; y: number; w: number; h: number } }> };
    const list = Array.isArray(parsed?.bugs) ? parsed.bugs : [];
    for (const b of list) {
      const t = (b.type ?? "").trim();
      const type: ReviewBug["type"] =
        t === "visual" || t === "ux" || t === "behavioral" || t === "a11y" || t === "performance" || t === "data"
          ? t
          : "visual";
      const severity = b.severity === "low" || b.severity === "medium" || b.severity === "high" ? b.severity : "medium";
      bugs.push({
        source: "review",
        stepIndex,
        type,
        description: (b.description ?? "").slice(0, 500),
        severity,
        region: b.region,
        at,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err), raw: raw?.slice(0, 200) }, "ReviewAgent: failed to parse LLM response");
  }
  return bugs;
}

function isLikelyUnstable(req: ReviewRequest): boolean {
  const titleLower = (req.title ?? "").toLowerCase();
  if (/loading|please wait|redirecting/i.test(titleLower)) return true;
  return false;
}

async function callReviewLLM(messages: any[]): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const config = getConfig();
  const { content, usage } = await llmChat(messages, config.reviewAgentModel, {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.1,
    timeoutMs: config.reviewTimeoutMs,
  });
  return {
    content,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}


async function processOne(
  req: ReviewRequest,
  recentBugDescriptions: string[],
  onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void,
): Promise<ReviewBug[]> {
  if (isLikelyUnstable(req)) {
    logger.debug({ stepIndex: req.stepIndex, title: req.title }, "ReviewAgent: skipping — page looks unstable/loading");
    return [];
  }
  const at = Date.now();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(req, recentBugDescriptions) },
  ];
  try {
    const { content, inputTokens, outputTokens } = await callReviewLLM(messages);
    const durationMs = Date.now() - at;
    const model = getConfig().reviewAgentModel;
    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);
    onLLMCall?.({
      stepIndex: req.stepIndex,
      model,
      hasVision: true,
      attempt: 1,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs,
      costUsd: calcCostUsd(model, inputTokens, outputTokens, "reviewAgentModel"),
      query: `Review step ${req.stepIndex}: ${req.action} \u2192 ${req.actionResult}`,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: content,
      agent: "review",
    });
    return parseReviewResponse(content, req.stepIndex, at);
  } catch (err) {
    logger.warn({ stepIndex: req.stepIndex, err: String(err) }, "ReviewAgent: LLM call failed");
    return [];
  }
}

const REVIEW_CONCURRENCY = 3;
const REVIEW_BUFFER_MAX = 20;

export type ReviewProcessor = {
  push: (request: ReviewRequest) => void;
  flush: () => Promise<ReviewBug[]>;
  /** Get bugs found so far (non-blocking, for mid-run cross-agent communication). */
  getCompletedBugs: () => ReviewBug[];
};

export function createReviewProcessor(opts?: { concurrency?: number; onLLMCall?: (call: Omit<LLMCallRecord, "seq">) => void }): ReviewProcessor {
  const concurrency = opts?.concurrency ?? REVIEW_CONCURRENCY;
  const onLLMCall = opts?.onLLMCall;
  const queue: ReviewRequest[] = [];
  const allBugs: ReviewBug[] = [];
  let running = 0;
  let resolveFlush: (() => void) | null = null;
  let flushPromise: Promise<void> | null = null;

  function getRecentBugDescriptions(): string[] {
    return allBugs.slice(-10).map(b => b.description);
  }

  function drain(): void {
    while (running < concurrency && queue.length > 0) {
      const req = queue.shift()!;
      running++;
      processOne(req, getRecentBugDescriptions(), onLLMCall).then((bugs) => {
        allBugs.push(...bugs);
        running--;
        drain();
        if (running === 0 && queue.length === 0 && resolveFlush) {
          resolveFlush();
          resolveFlush = null;
        }
      });
    }
  }

  return {
    push(request: ReviewRequest) {
      queue.push(request);
      // Backpressure: prefer dropping mid-page screenshots; keep navigation-boundary frames
      while (queue.length > REVIEW_BUFFER_MAX) {
        const dropIdx = queue.findIndex((r) => !r.isNavigationBoundary);
        if (dropIdx >= 0) {
          const dropped = queue.splice(dropIdx, 1)[0];
          logger.debug({ stepIndex: dropped.stepIndex }, "ReviewAgent: dropped mid-page queued item (backpressure)");
        } else {
          const dropped = queue.shift();
          if (dropped) logger.debug({ stepIndex: dropped.stepIndex }, "ReviewAgent: dropped oldest queued item (backpressure)");
        }
      }
      drain();
    },
    flush(): Promise<ReviewBug[]> {
      if (queue.length === 0 && running === 0) return Promise.resolve([...allBugs]);
      if (!flushPromise) {
        flushPromise = new Promise<void>((resolve) => {
          resolveFlush = resolve;
        });
      }
      return flushPromise.then(() => [...allBugs]);
    },
    getCompletedBugs(): ReviewBug[] {
      return [...allBugs];
    },
  };
}
