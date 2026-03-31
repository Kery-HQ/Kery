/**
 * Browser automation agent — the Navigator.
 *
 * This is the core agent loop that drives a Playwright page via LLM decisions.
 * It observes the page (a11y tree + screenshot), asks the LLM what to do next,
 * executes the action, and repeats until the intent is fulfilled or limits are hit.
 *
 * NOTE: This file is intentionally large (~1600 lines) as it contains the full
 * agent loop, auth handling, DOM extraction, action execution, and conversation
 * management. All business logic is preserved from the source repository.
 */
import type { Page } from "playwright";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import type { AuthConfig } from "./types.js";
import type { MemoryEntry } from "./agentMemory.js";
import { formatMemoryForPrompt } from "./agentMemory.js";
import { llmAgentChat, calcCostUsd } from "./llmClient.js";
import { extractA11yTree, formatA11yForLLM, hasSufficientA11y, resolveElement, injectElementMarkers, removeElementMarkers, extractVisibleText, type A11yElement, type A11yTextNode } from "./a11yTree.js";
import { handleTokenAuth, refreshIfNeeded } from "./tokenAuth.js";
import {
  stagehandObserve, formatObserveForLLM, hasSufficientObserve,
  stagehandAct, actionToInstruction, isObserveCircuitOpen,
  type ObservedElement, type StagehandSession,
} from "./stagehandBridge.js";

export type DoneResult = "completed" | "blocked";

export type AgentAction = {
  action: "fill" | "click" | "navigate" | "assert" | "wait" | "done"
    | "hover" | "scroll" | "pressKey" | "selectOption" | "back"
    | "dragAndDrop" | "setDate" | "observe" | "plan" | "report_bug";
  element?: number;
  target?: string;
  value?: string;
  x?: number;
  y?: number;
  /** For dragAndDrop: destination coordinates (0-1000 normalized) */
  toX?: number;
  toY?: number;
  assertion?: string;
  reasoning?: string;
  /** Behavioral note for the Review Agent (unexpected UI state, no feedback, etc.) */
  observation?: string;
  /** When action is "done": how the run finished (default completed). */
  result?: DoneResult;
  /** Meta action: create or update plan checklist */
  planItems?: Array<string | { text: string; status?: "pending" | "done" | "current" | "failed" }>;
  /** Meta action: report a bug during run */
  bugDescription?: string;
  bugType?: "visual" | "functional" | "ux" | "other";
  severity?: "low" | "medium" | "high";
};

export type RunStep = {
  index: number;
  action: string;
  element?: number;
  target?: string;
  value?: string;
  x?: number;
  y?: number;
  assertion?: string;
  reasoning?: string;
  url?: string;
  status: "ok" | "failed" | "skipped";
  error?: string;
  fromMemory: boolean;
  bugType?: "visual" | "functional" | "ux" | "other";
  severity?: "low" | "medium" | "high";
  at?: number;
  source?: "navigator" | "review" | "pathgen" | "filmstrip";
  elementRef?: { role: string; name: string };
  screenshotBase64?: string;
  /** After materialize: JPEG filename under SCREENSHOTS_DIR/<runId>/ */
  screenshotPath?: string;
  /** Optional bounding box for review/filmstrip bugs (0–1000 normalized or pixels); burned into JPEG when materializing. */
  region?: { x: number; y: number; w: number; h: number };
  /** Formatted a11y / element list the Navigator saw before deciding this action */
  domContext?: string;
  /** URL+DOM hash at start of this step (before the action executed) — for Review Agent domChanged */
  preActionDomHash?: string;
  /** How the action was executed */
  executionMethod?: "stagehand" | "playwright" | "coordinates";
  /** Review-agent bugs attached to this step (set by orchestrator) */
  reviewFeedback?: { type: string; severity: string; description: string }[];
  /** Navigator behavioral observation (from LLM), forwarded to Review Agent */
  observation?: string;
  /** When action is "done", completion semantics from the Navigator */
  doneResult?: DoneResult;
};

export type LLMAgentType =
  | "navigator"
  | "review"
  | "holistic"
  | "pathgen"
  | "summary"
  | "filmstrip"
  | "crawl_link_filter"
  | "crawl_suggested_flows";

/** Serializable multimodal message for run-detail UI (no raw base64 — images are parallel `imageBase64s` / `imagePaths`). */
export type LLMStoredContentPart =
  | { type: "text"; text: string }
  | { type: "image"; imageIndex: number; label?: string };

export type LLMStoredMessage = {
  role: string;
  content: string | LLMStoredContentPart[];
};

export type LLMCallRecord = {
  seq: number;
  stepIndex: number;
  model: string;
  hasVision: boolean;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  costUsd: number;
  /** Primary user text from the last user turn (full; legacy search field). */
  query: string;
  /** Exact messages sent to the provider (text + image index refs). */
  requestMessages?: LLMStoredMessage[];
  /** Raw base64 JPEG chunks for this call, before materialization to disk. */
  imageBase64s?: string[];
  /** After materialize: JPEG filenames under SCREENSHOTS_DIR/<runId>/ */
  imagePaths?: string[];
  imageBase64?: string;
  /** After materialize: first image filename (legacy). */
  imagePath?: string;
  response: string;
  role?: "action" | "dom-scan";
  agent?: LLMAgentType;
  /** Crawl runs: batch index, source page route, outcome notes, etc. */
  crawlContext?: Record<string, unknown>;
};

function dataUrlToBase64(url: string): string | null {
  const m = /^data:image\/[^;]+;base64,(.+)$/i.exec(url);
  return m?.[1] ?? null;
}

/**
 * Converts OpenAI-style wire messages into storable JSON + parallel base64 image list.
 */
export function serializeWireMessagesForStorage(messages: any[]): { messages: LLMStoredMessage[]; imageBase64s: string[] } {
  const imageBase64s: string[] = [];
  const out: LLMStoredMessage[] = [];
  for (const m of messages) {
    const role = m.role ?? "unknown";
    if (typeof m.content === "string") {
      out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      out.push({ role, content: typeof m.content === "object" ? JSON.stringify(m.content) : String(m.content) });
      continue;
    }
    const parts: LLMStoredContentPart[] = [];
    for (const p of m.content) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text ?? "" });
      } else if (p.type === "image_url" && p.image_url?.url) {
        const url = p.image_url.url as string;
        const b64 = dataUrlToBase64(url);
        if (b64) {
          const idx = imageBase64s.length;
          imageBase64s.push(b64);
          parts.push({ type: "image", imageIndex: idx });
        }
      }
    }
    out.push({ role, content: parts.length > 0 ? parts : [{ type: "text", text: "" }] });
  }
  return { messages: out, imageBase64s };
}

function concatLastUserTextFromWire(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.content)) return "";
    return msg.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n\n");
  }
  return "";
}

export type AgentResult = {
  status: "passed" | "failed";
  steps: string[];
  stepsDetail: RunStep[];
  bugsFound: RunStep[];
  llmCalls: LLMCallRecord[];
  failReason?: string;
};

const DEFAULT_MAX_STEPS = 50;
const MAX_STEPS_HARD_CAP = 250;
const MAX_DOM_CHARS = 6000;
/** Stored on each RunStep for run-detail observability (UI). */
const MAX_STEP_DOM_CONTEXT = 12_000;
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;
const LOOP_WINDOW = 6;
const LOOP_THRESHOLD = 3;
const LOOP_FORCE_EXIT_AFTER = 4;
const COORD_PROXIMITY = 50;
const MAX_META_ACTIONS = 3;

type RecentAction = { action: string; x?: number; y?: number; target?: string; element?: number; elementName?: string; value?: string; assertion?: string; url?: string };

const LOOP_EXEMPT_ACTIONS = new Set(["assert", "wait"]);

function detectActionRepetition(recent: RecentAction[]): { stuck: boolean; repeatedKey?: string; repeatCount?: number } {
  const stateful = recent.filter(r => !LOOP_EXEMPT_ACTIONS.has(r.action));
  if (stateful.length < LOOP_THRESHOLD) return { stuck: false };
  const counts = new Map<string, number>();
  for (const r of stateful) {
    let key: string;
    if (r.element != null) {
      const name = r.elementName?.slice(0, 20) || "";
      key = `${r.action}:el${r.element}:${name}`;
    } else if (r.x != null && r.y != null) {
      key = `${r.action}@${Math.round((r.x / 1000) * VIEWPORT_W / COORD_PROXIMITY)}:${Math.round((r.y / 1000) * VIEWPORT_H / COORD_PROXIMITY)}`;
    } else {
      const identifier = r.value || r.target || "?";
      key = `${r.action}::${identifier.slice(0, 40)}`;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, c] of counts.entries()) {
    if (c >= LOOP_THRESHOLD) return { stuck: true, repeatedKey: key, repeatCount: c };
  }
  return { stuck: false };
}

const MUTATING_ACTIONS = new Set(["click", "fill", "selectOption", "pressKey", "dragAndDrop", "setDate"]);

function doneResultToStatus(result: DoneResult | undefined): "passed" | "failed" {
  switch (result) {
    case "blocked":
      return "failed";
    case "completed":
    default:
      return "passed";
  }
}

function stepTimestamp(): number {
  const perf = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
  return Date.now() + (perf % 1);
}

/** Simple hash for comparing DOM snapshots between steps. */
function simpleDomHash(url: string, dom: string): string {
  let h = 0;
  const str = url + "|" + dom;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return String(h);
}

function isSamePage(currentUrl: string, targetUrl: string): boolean {
  try {
    const a = new URL(currentUrl);
    const b = new URL(targetUrl);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

// ─── Wait for page stable ─────────────────────────────────────────────────────

export async function waitForPageStable(page: Page, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Phase 1: wait for network idle (most important for SPAs making API calls)
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 2000) });
  } catch { /* best-effort */ }

  // Phase 2: wait for DOM to quiesce (MutationObserver — catches async renders)
  const remaining = deadline - Date.now();
  if (remaining > 200) {
    try {
      await page.evaluate((ms) => new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { observer.disconnect(); resolve(); }, 150);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(() => { observer.disconnect(); resolve(); }, ms);
      }), Math.min(remaining, 1500));
    } catch { /* page might have navigated */ }
  }

  // Phase 3: one rAF to flush visual updates
  const remaining2 = deadline - Date.now();
  if (remaining2 > 50) {
    try {
      await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
    } catch { /* ignore */ }
  }
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

type DOMElementInfo = {
  kind: string;
  text: string;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  extra?: string;
};

type DOMSnapshot = {
  forms: DOMElementInfo[];
  clickables: DOMElementInfo[];
};

const DOM_EXTRACT_SCRIPT = `(function() {
  var vw = window.innerWidth || 1920;
  var vh = window.innerHeight || 1080;
  function vis(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  }
  function getLabel(el) {
    if (el.id) { var lbl = document.querySelector('label[for="' + el.id + '"]'); if (lbl) return (lbl.textContent || '').trim().slice(0, 40); }
    var closest = el.closest('label'); if (closest) return (closest.textContent || '').trim().slice(0, 40);
    var aria = el.getAttribute('aria-label'); if (aria) return aria.slice(0, 40);
    return '';
  }
  function getText(el) {
    var aria = el.getAttribute('aria-label'); if (aria) return aria.trim().slice(0, 50);
    if (el.tagName === 'INPUT' && ['submit','button','reset'].includes(el.type)) return (el.value || aria || 'Submit').slice(0, 50);
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' '); return text.slice(0, 50);
  }
  function bbox(r) {
    var cx = Math.round(((r.left + r.width / 2) / vw) * 1000);
    var cy = Math.round(((r.top + r.height / 2) / vh) * 1000);
    return { cx: Math.max(0, Math.min(1000, cx)), cy: Math.max(0, Math.min(1000, cy)), x1: Math.round(r.left), y1: Math.round(r.top), x2: Math.round(r.right), y2: Math.round(r.bottom) };
  }
  var forms = []; var seen = {};
  [].forEach.call(document.querySelectorAll('input:not([type=hidden]), textarea'), function(el) {
    if (!vis(el)) return; var key = el.name || el.id || el.placeholder || el.type; if (seen[key]) return; seen[key] = 1;
    var r = el.getBoundingClientRect(); var b = bbox(r); var label = getLabel(el);
    var req = (el.required || el.getAttribute('aria-required') === 'true') ? ' required' : '';
    var dis = el.disabled ? ' disabled' : ''; var val = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
    forms.push({ kind: 'INPUT', text: label, cx: b.cx, cy: b.cy, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, extra: 'type=' + (el.type||'text') + ' placeholder="' + (el.placeholder||'') + '"' + val + req + dis });
  });
  [].forEach.call(document.querySelectorAll('select'), function(el) {
    if (!vis(el)) return; var key = el.name || el.id || 'select'; if (seen[key]) return; seen[key] = 1;
    var r = el.getBoundingClientRect(); var b = bbox(r); var label = getLabel(el);
    var opts = [].slice.call(el.options, 0, 6).map(function(o){ return o.text; }).join(', ');
    forms.push({ kind: 'SELECT', text: label, cx: b.cx, cy: b.cy, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, extra: '[' + opts + ']' });
  });
  var clickables = []; var clickSeen = {};
  var sel = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [onclick], [tabindex="0"]';
  [].forEach.call(document.querySelectorAll(sel), function(el) {
    if (!vis(el)) return; if (el.closest('[aria-hidden="true"]')) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
    if (el.tagName === 'INPUT' && !['submit','button','reset'].includes(el.type)) return;
    var text = getText(el); if (!text || text.length < 2) return;
    var r = el.getBoundingClientRect(); var b = bbox(r);
    var dedupe = text.toLowerCase().slice(0, 30) + '|' + b.cx + '|' + b.cy; if (clickSeen[dedupe]) return; clickSeen[dedupe] = 1;
    var tag = el.tagName.toLowerCase(); var kind = tag === 'a' ? 'LINK' : tag === 'button' ? 'BUTTON' : (el.getAttribute('role') || tag).toUpperCase();
    var extra = el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : undefined;
    clickables.push({ kind: kind, text: text, cx: b.cx, cy: b.cy, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, extra: extra });
  });
  return JSON.stringify({ forms: forms, clickables: clickables });
})()`;

function formatDOMForLLM(snapshot: DOMSnapshot): string {
  const sections: string[] = [];
  if (snapshot.forms.length > 0) {
    const lines = snapshot.forms.map(f => `${f.kind} "${f.text}" @(${f.cx},${f.cy})${f.extra ? " " + f.extra : ""}`);
    sections.push(`Form fields:\n${lines.join("\n")}`);
  }
  if (snapshot.clickables.length > 0) {
    const lines = snapshot.clickables.map(c => `${c.kind} "${c.text}" @(${c.cx},${c.cy})`);
    sections.push(`Clickable elements:\n${lines.join("\n")}`);
  }
  return sections.join("\n\n") || "(no interactive elements)";
}

async function extractDOM(page: Page): Promise<{ text: string; snapshot: DOMSnapshot }> {
  const emptySnapshot: DOMSnapshot = { forms: [], clickables: [] };
  let mainSnapshot: DOMSnapshot;
  try {
    const raw = await page.evaluate(DOM_EXTRACT_SCRIPT) as string;
    mainSnapshot = JSON.parse(raw) as DOMSnapshot;
  } catch (err) {
    logger.warn({ err: String(err) }, "DOM extraction failed");
    return { text: "(DOM extraction failed)", snapshot: emptySnapshot };
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const frameUrl = frame.url();
    if (!frameUrl || frameUrl === "about:blank") continue;
    try {
      const raw = await frame.evaluate(DOM_EXTRACT_SCRIPT).catch(() => null) as string | null;
      if (!raw) continue;
      const frameSnap = JSON.parse(raw) as DOMSnapshot;
      if (frameSnap.forms.length > 0 || frameSnap.clickables.length > 0) {
        mainSnapshot.forms.push(...frameSnap.forms);
        mainSnapshot.clickables.push(...frameSnap.clickables);
      }
    } catch {}
  }
  let text = formatDOMForLLM(mainSnapshot);
  if (text.length > MAX_DOM_CHARS) text = text.slice(0, MAX_DOM_CHARS);
  return { text, snapshot: mainSnapshot };
}

function trimDomContext(dom: string | undefined): string | undefined {
  if (!dom || dom === "(DOM extraction failed)") return undefined;
  if (dom.length <= MAX_STEP_DOM_CONTEXT) return dom;
  return `${dom.slice(0, MAX_STEP_DOM_CONTEXT)}\n\n...[truncated ${dom.length - MAX_STEP_DOM_CONTEXT} chars]`;
}

function executionUsesCoordinates(action: AgentAction): boolean {
  if (action.x == null || action.y == null) return false;
  return ["click", "fill", "hover", "selectOption", "scroll"].includes(action.action);
}

// ─── Stable snapshot (a11y + stagehand + DOM fallback) ───────────────────────

async function takeStableSnapshot(page: Page, stagehand?: any): Promise<{
  screenshot: Buffer;
  cleanScreenshot: Buffer;
  dom: string;
  url: string;
  title: string;
  pageText: string;
  a11yElements?: A11yElement[];
  a11yTextNodes?: A11yTextNode[];
  observedElements?: ObservedElement[];
}> {
  await waitForPageStable(page, 3000);
  const url = page.url();
  const title = await page.title().catch(() => "");

  // Take clean screenshot (before any marker injection — for review agent)
  // Higher quality (90%) for review agent accuracy; marked screenshot uses 75% to save navigator tokens
  const cleanScreenshot = await page.screenshot({ type: "jpeg", quality: 90 }).catch(() => Buffer.alloc(0));

  // Try Stagehand observe first
  let observedElements: ObservedElement[] | undefined;
  if (stagehand && isObserveCircuitOpen()) {
    logger.info({ url }, "Snapshot: Stagehand observe skipped (circuit open), will use a11y or DOM fallback");
  }
  if (stagehand && !isObserveCircuitOpen()) {
    observedElements = await stagehandObserve(stagehand);
    if (hasSufficientObserve(observedElements)) {
      const dom = formatObserveForLLM(observedElements);
      const pageText = await extractVisibleText(page);
      logger.info(
        { url, domSource: "stagehand", observeCount: observedElements.length, screenshotBytes: cleanScreenshot.length },
        "Snapshot complete",
      );
      return { screenshot: cleanScreenshot, cleanScreenshot, dom, url, title, pageText, observedElements };
    }
    logger.info({ url, observeCount: observedElements?.length ?? 0 }, "Snapshot: Stagehand observe insufficient, falling back to a11y");
  }

  // Try a11y tree
  const { elements: a11yElements, textNodes: a11yTextNodes } = await extractA11yTree(page);
  if (hasSufficientA11y(a11yElements)) {
    await injectElementMarkers(page, a11yElements);
    const markedScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => cleanScreenshot);
    await removeElementMarkers(page);
    const dom = formatA11yForLLM(a11yElements, a11yTextNodes);
    const pageText = await extractVisibleText(page);
    logger.info(
      {
        url,
        domSource: "a11y",
        interactiveCount: a11yElements.length,
        screenshotBytes: markedScreenshot.length,
      },
      "Snapshot complete",
    );
    return { screenshot: markedScreenshot, cleanScreenshot, dom, url, title, pageText, a11yElements, a11yTextNodes };
  }

  // Fallback to DOM extraction
  const { text: dom } = await extractDOM(page);
  const pageText = await extractVisibleText(page);
  logger.info({ url, domSource: "dom_extract", screenshotBytes: cleanScreenshot.length }, "Snapshot complete");
  return { screenshot: cleanScreenshot, cleanScreenshot, dom, url, title, pageText, a11yElements, a11yTextNodes };
}

// ─── System prompt builder ────────────────────────────────────────────────────

const IMAGE_KEEP_LAST = 3;

function buildSystemPrompt(params: {
  intent: string;
  context?: string;
  memoryEntries: MemoryEntry[];
  targetUrl?: string;
}): string {
  const memorySection = formatMemoryForPrompt(params.memoryEntries);
  const contextSection = params.context
    ? `\nTest context (what to check / expected behaviors):\n${params.context}\n`
    : "";
  const targetSection = params.targetUrl
    ? `\nTarget page: ${params.targetUrl}\nYou have been navigated to this page. Focus ALL testing on this page only. Do NOT navigate away, click "Back", or go to other pages. If you run out of things to test, call "done".\n`
    : "";
  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return `You are a web testing agent. You interact with a web app to test it.

Current date/time: ${now}
Intent: "${params.intent}"
${targetSection}${contextSection}
${memorySection ? memorySection + "\n" : ""}ELEMENTS: Each interactive element has a number [N]. Reference elements by number using the "element" field.
Example: To click the Login button shown as [3], use {"action":"click","element":3,"reasoning":"..."}
Example: To fill Username shown as [1], use {"action":"fill","element":1,"value":"test@example.com","reasoning":"..."}

Optional fields (use when relevant):
- "observation": Short note on unexpected application behavior (e.g. button state unchanged after click, missing feedback). These notes are forwarded to the Review Agent for analysis. Do not report bugs here — only describe what you observe.
- "result" (only with action "done"): "completed" when you finish the flow (even if bugs might still be found by reviewers), "blocked" if you cannot proceed due to app issues (non-responsive UI, errors).

FALLBACK: If an element is not in the list, use x,y coordinates (integers 0-1000) instead.

ACTIONS:
- click, fill, pressKey, selectOption, scroll, hover, navigate, assert, back, wait, done
- dragAndDrop: drag from element/x,y to toX,toY (all 0-1000). Example: {"action":"dragAndDrop","element":5,"toX":700,"toY":300,"reasoning":"..."}
- setDate: set a date picker — use "element" for the input, "value" for the date string (ISO or display format). The agent will clear + type + confirm.
- observe: request a fresh snapshot without interacting. Use this to verify state before deciding next step. Example: {"action":"observe","reasoning":"Verify cart count updated after add-to-cart clicks"}
- plan: create/update a checklist to track progress. Example: {"action":"plan","planItems":[{"text":"Add item 1","status":"done"},{"text":"Add item 2","status":"current"},{"text":"Verify cart count","status":"pending"}],"reasoning":"Track multi-step flow"}
- report_bug: log an in-memory bug for this run. Example: {"action":"report_bug","bugDescription":"Third Add to cart click has no effect","bugType":"functional","severity":"high","reasoning":"Button stays Add to cart and cart count does not change"}

RULES:
- Don't fill fields that already have the correct value (check the "value" shown in the element list).
- A disabled element cannot be interacted with \u2014 change something first.
- Auth in conversation history = already logged in, skip re-login.
- If on wrong page, use navigate to go directly to the target URL.
- When the observation mentions DOM stagnation or loop warnings, reason about whether the app is broken vs. a different strategy is needed; call done with result "blocked" if the app is genuinely non-responsive.
- Keep one clear goal: satisfy the Intent exactly and do not wander to unrelated flows.
- Before calling done, ALWAYS verify final state with at least one observe action and confirm expected evidence (counts, labels, destination page state).

IMPORTANT: Reply with EXACTLY ONE JSON object. Do NOT output multiple actions — only the single next action to take.`;
}

// ─── Observation builder ──────────────────────────────────────────────────────

function buildObservation(params: {
  url: string;
  title: string;
  dom: string;
  screenshot: Buffer;
  pageText?: string;
  failedTargets?: string[];
  stuckWarning?: boolean;
  targetUrl?: string;
  planState?: string;
  bugTrackerState?: string;
  stuckHint?: string;
  domStagnationAdvisory?: { action: string; elementName?: string };
  repetitionLoopAdvisory?: boolean;
  repeatedKey?: string;
  networkHint?: string;
  prevResult?: {
    action: AgentAction;
    status: "ok" | "failed";
    error?: string;
    clickedElement?: string;
    clickProofScreenshot?: Buffer;
  };
}): any[] {
  const parts: string[] = [];

  if (params.prevResult) {
    const a = params.prevResult.action;
    const loc = a.x != null && a.y != null ? ` @(${a.x},${a.y})` : "";
    const target = a.target ? ` \u2192 ${a.target}` : "";
    if (params.prevResult.status === "ok") {
      parts.push(`Previous: ${a.action}${loc}${target} \u2192 OK`);
      if (params.prevResult.clickedElement) {
        parts.push(`Clicked element: ${params.prevResult.clickedElement}`);
      }
    } else {
      parts.push(`Previous: ${a.action}${loc}${target} \u2192 FAILED: ${params.prevResult.error}`);
    }
  }

  if (params.planState) parts.push(params.planState);
  if (params.bugTrackerState) parts.push(params.bugTrackerState);
  parts.push(`URL: ${params.url}\nTitle: "${params.title}"`);

  if (params.dom && params.dom !== "(no interactive elements)" && params.dom !== "(DOM extraction failed)") {
    parts.push(params.dom);
  }

  if (params.pageText && !params.dom.includes("Page content:")) {
    parts.push(`Visible text on page:\n${params.pageText}`);
  }

  if (params.stuckHint) parts.push(params.stuckHint);

  if (params.failedTargets && params.failedTargets.length > 0) {
    parts.push(`Failed targets (avoid):\n${params.failedTargets.map(s => `  - ${s}`).join("\n")}`);
  }

  if (params.domStagnationAdvisory) {
    const el = params.domStagnationAdvisory.elementName ? ` on '${params.domStagnationAdvisory.elementName}'` : "";
    parts.push(
      `DOM STAGNATION: Your last ${params.domStagnationAdvisory.action}${el} had no visible effect on the page (DOM snapshot unchanged). ` +
        `This may mean the application is not responding to this interaction. Consider: (1) it could be an application bug — the control appears interactive but does nothing, ` +
        `(2) try a different approach (scroll, another element, navigate), (3) if you believe the app is genuinely non-responsive here, call done with {"action":"done","result":"blocked","reasoning":"..."}.`,
    );
  }

  if (params.repetitionLoopAdvisory && params.repeatedKey) {
    parts.push(
      `ACTION REPETITION: You repeated the same interaction pattern (${params.repeatedKey}). ` +
        `Try a different strategy or call done with result "blocked" if the app will not progress.`,
    );
  }

  if (params.stuckWarning) {
    if (params.targetUrl) {
      parts.push(`LOOP SIGNAL: Repeated actions detected. Stay on this page (${params.targetUrl}) unless you must navigate elsewhere.`);
    } else {
      parts.push(`LOOP SIGNAL: Repeated actions detected. Try a different approach or call done with an appropriate result.`);
    }
  }

  if (params.networkHint) {
    parts.push(params.networkHint);
  }

  const text = parts.join("\n\n");
  const content: any[] = [{ type: "text", text }];

  if (params.screenshot.length > 0) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${params.screenshot.toString("base64")}`,
        detail: "auto",
      },
    });
  }

  if (params.prevResult?.clickProofScreenshot && params.prevResult.clickProofScreenshot.length > 0) {
    content.push({ type: "text", text: "[Click location marked with red dot]" });
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${params.prevResult.clickProofScreenshot.toString("base64")}`,
        detail: "auto",
      },
    });
  }

  return content;
}

// ─── Progress Summary (survives conversation pruning) ────────────────────────

class ProgressSummary {
  private pagesVisited = new Set<string>();
  private actionsCompleted: string[] = [];
  private bugsFound: string[] = [];
  private failedAttempts: string[] = [];

  recordStep(step: RunStep): void {
    if (step.url) this.pagesVisited.add(new URL(step.url).pathname);
    if (step.action !== "done" && step.status === "ok") {
      this.actionsCompleted.push(`${step.action} ${step.target ?? ""}`.trim());
    }
    if (step.status === "failed") {
      this.failedAttempts.push(`${step.action} ${step.target ?? ""}`.trim());
    }
  }

  recordBug(name: string): void {
    this.bugsFound.push(name);
  }

  format(): string {
    if (this.actionsCompleted.length === 0) return "";
    const lines = [
      `PROGRESS SUMMARY (${this.actionsCompleted.length} actions completed):`,
      `Pages visited: ${[...this.pagesVisited].join(", ") || "none"}`,
      `Recent actions: ${this.actionsCompleted.slice(-10).join("; ")}`,
    ];
    if (this.bugsFound.length > 0) {
      lines.push(`Bugs found so far: ${this.bugsFound.join("; ")}`);
    }
    if (this.failedAttempts.length > 0) {
      lines.push(`Failed attempts: ${this.failedAttempts.slice(-5).join("; ")}`);
    }
    return lines.join("\n");
  }
}

type AgentPlanItem = {
  text: string;
  status: "pending" | "done" | "current" | "failed";
};

function normalizePlanItems(
  input: Array<string | { text: string; status?: "pending" | "done" | "current" | "failed" }> | undefined,
): AgentPlanItem[] {
  if (!Array.isArray(input)) return [];
  const out: AgentPlanItem[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      out.push({ text, status: "pending" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    const status = item.status === "done" || item.status === "current" || item.status === "failed"
      ? item.status
      : "pending";
    out.push({ text, status });
  }
  let sawCurrent = false;
  for (const step of out) {
    if (step.status === "current") {
      if (!sawCurrent) sawCurrent = true;
      else step.status = "pending";
    }
  }
  if (!sawCurrent) {
    const firstPending = out.find((s) => s.status === "pending");
    if (firstPending) firstPending.status = "current";
  }
  return out;
}

function formatAgentPlanState(plan: AgentPlanItem[]): string {
  if (plan.length === 0) return "";
  const lines = plan.map((item, idx) => {
    const marker =
      item.status === "done"
        ? "[done]"
        : item.status === "failed"
          ? "[FAIL]"
          : item.status === "current"
            ? "[NOW]"
            : "[ ]";
    return `  ${marker} ${idx + 1}. ${item.text}`;
  });
  const current = plan.find((p) => p.status === "current");
  return `CHECKLIST (maintain this with action "plan"):\n${lines.join("\n")}${current ? `\nCURRENT OBJECTIVE: ${current.text}` : ""}`;
}

function formatBugTrackerState(bugs: RunStep[]): string {
  if (bugs.length === 0) return "IN-MEMORY BUG TRACKER: none reported yet.";
  const recent = bugs.slice(-8).map((b, i) => {
    const sev = (b.severity ?? "medium").toUpperCase();
    return `  ${i + 1}. [${sev}] ${b.reasoning ?? "Bug reported"}`;
  });
  return `IN-MEMORY BUG TRACKER (${bugs.length}):\n${recent.join("\n")}`;
}

// ─── Conversation pruning ─────────────────────────────────────────────────────

const KEEP_FULL_TURNS = 5;
/** Beyond this many user turns, aggressively collapse old turns into a single summary message. */
const COLLAPSE_AFTER_TURNS = 12;

function pruneConversation(messages: any[]): void {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    userCount++;
    if (!Array.isArray(msg.content)) continue;
    const hasImage = msg.content.some((p: any) => p.type === "image_url");
    if (hasImage && userCount > IMAGE_KEEP_LAST) {
      msg.content = msg.content.filter((p: any) => p.type !== "image_url");
    }
    if (userCount > KEEP_FULL_TURNS) {
      const textPart = msg.content.find((p: any) => p.type === "text");
      if (textPart?.text && textPart.text.length > 200) {
        const prevMatch = textPart.text.match(/^Previous: (.+?)$/m);
        const urlMatch = textPart.text.match(/^URL: (.+?)$/m);
        const summary = [
          prevMatch ? prevMatch[1] : null,
          urlMatch ? `URL: ${urlMatch[1]}` : null,
        ].filter(Boolean).join(" | ") || textPart.text.slice(0, 100);
        textPart.text = summary;
      }
    }
  }

  // Aggressive collapse: on long runs, merge old summarized turns into one block
  if (userCount > COLLAPSE_AFTER_TURNS) {
    collapseOldTurns(messages);
  }
}

function collapseOldTurns(messages: any[]): void {
  // messages[0] is always system. Keep system + last KEEP_FULL_TURNS*2 messages intact.
  const keepTail = KEEP_FULL_TURNS * 2 + 1; // user + assistant pairs + system
  if (messages.length <= keepTail + 4) return;

  const cutoff = messages.length - keepTail;
  const collapsedLines: string[] = [];
  for (let i = 1; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(typeof msg.content === "string" ? msg.content : "");
        if (parsed?.action) {
          const val = parsed.value ? ` "${parsed.value}"` : "";
          collapsedLines.push(`${parsed.action} ${parsed.target ?? ""}${val}`.trim());
        }
      } catch { /* skip */ }
    } else if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join(" ")
          : "";
      const urlMatch = text.match(/URL: (.+?)(\n|$)/);
      const prevMatch = text.match(/Previous: (.+?)(\n|$)/);
      if (prevMatch || urlMatch) {
        collapsedLines.push([prevMatch?.[1], urlMatch ? `@ ${urlMatch[1]}` : null].filter(Boolean).join(" "));
      }
    }
  }

  if (collapsedLines.length === 0) return;

  const summaryMsg = {
    role: "user" as const,
    content: [{ type: "text", text: `EARLIER ACTIONS (condensed):\n${collapsedLines.join("\n")}` }],
  };

  messages.splice(1, cutoff - 1, summaryMsg);
}

// ─── Action validation & sanitization ─────────────────────────────────────────

function sanitizeAction(action: AgentAction): AgentAction {
  for (const key of Object.keys(action) as (keyof AgentAction)[]) {
    if ((action as any)[key] === null) delete (action as any)[key];
  }
  return action;
}

function validateAction(action: AgentAction): string | null {
  const hasElement = action.element != null;
  if (action.action === "click" || action.action === "hover") {
    if (!hasElement && action.x == null && action.y == null && !action.target) {
      return `"${action.action}" requires an element number, x/y coordinates, or a target.`;
    }
  }
  if (action.action === "fill") {
    if (!action.value && action.value !== "") return `"fill" requires a "value" field.`;
    if (!hasElement && action.x == null && action.y == null && !action.target) return `"fill" requires an element number, x/y, or target.`;
  }
  if (action.action === "pressKey") {
    if (!action.value?.trim()) return `"pressKey" requires a key name in "value".`;
  }
  if (action.action === "selectOption") {
    if (!hasElement && (action.x == null || action.y == null)) return `"selectOption" requires an element or x/y.`;
    if (!action.value?.trim()) return `"selectOption" requires the option label in "value".`;
  }
  if (action.action === "scroll") {
    const v = (action.value ?? "").trim().toLowerCase();
    if (!v.match(/^(up|down|left|right)\s+\d+$/)) return `"scroll" requires "value" in format "down 300".`;
  }
  if (action.action === "plan") {
    if (!Array.isArray(action.planItems) || action.planItems.length === 0) {
      return `"plan" requires a non-empty "planItems" array.`;
    }
  }
  if (action.action === "report_bug") {
    if (!action.bugDescription?.trim()) return `"report_bug" requires "bugDescription".`;
  }
  return null;
}

function buildCorrectionPrompt(action: AgentAction, error: string): string {
  const badJson = JSON.stringify(action);
  return `ERROR: Your action is invalid.\nYou sent: ${badJson}\nProblem: ${error}\nReply with a corrected JSON action.`;
}

// ─── LLM decision ─────────────────────────────────────────────────────────────

async function decideNextAction(params: {
  messages: any[];
  stepIndex: number;
  llmCallSeq: { current: number };
  onLLMCall: (call: LLMCallRecord) => void;
}): Promise<AgentAction> {
  pruneConversation(params.messages);

  for (let attempt = 0; attempt < 3; attempt++) {
    let callMessages = params.messages;
    if (attempt > 0) {
      callMessages = params.messages.map((m, idx) => {
        if (idx === params.messages.length - 1 && m.role === "user" && Array.isArray(m.content)) {
          return { ...m, content: m.content.filter((p: any) => p.type !== "image_url") };
        }
        return m;
      });
    }

    if (attempt === 2) await new Promise(r => setTimeout(r, 2000));

    const t0 = Date.now();
    const { content: raw, usage } = await llmAgentChat(callMessages);
    const durationMs = Date.now() - t0;
    const hasVision = attempt === 0;

    const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(callMessages);
    const queryText = concatLastUserTextFromWire(callMessages) || "[multi-turn]";

    params.llmCallSeq.current++;
    params.onLLMCall({
      seq: params.llmCallSeq.current,
      stepIndex: params.stepIndex,
      model: getConfig().agentModel,
      hasVision,
      attempt: attempt + 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      costUsd: calcCostUsd(getConfig().agentModel, usage.inputTokens, usage.outputTokens, "agentModel"),
      query: queryText,
      requestMessages,
      imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
      imageBase64: imageBase64s[0],
      response: raw,
      agent: "navigator",
    });

    if (!raw) continue;

    const start = raw.indexOf("{");
    if (start === -1) continue;

    // Extract first complete JSON object (handle LLM returning multiple concatenated objects)
    let depth = 0;
    let firstEnd = -1;
    for (let j = start; j < raw.length; j++) {
      if (raw[j] === "{") depth++;
      else if (raw[j] === "}") { depth--; if (depth === 0) { firstEnd = j; break; } }
    }
    if (firstEnd === -1) continue;

    const jsonSlice = raw.slice(start, firstEnd + 1);
    try {
      const parsed: AgentAction = JSON.parse(jsonSlice);
      return sanitizeAction(parsed);
    } catch {
      continue;
    }
  }

  logger.warn({ stepIndex: params.stepIndex }, "Navigator LLM: no valid JSON action after 3 attempts");
  throw new Error("No JSON after 3 attempts");
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function toPixel(x: number, y: number): { px: number; py: number } {
  return {
    px: Math.round((x / 1000) * VIEWPORT_W),
    py: Math.round((y / 1000) * VIEWPORT_H),
  };
}

async function describeElementAtPoint(page: Page, px: number, py: number): Promise<string> {
  try {
    return await page.evaluate(([cx, cy]: number[]) => {
      const el = document.elementFromPoint(cx, cy);
      if (!el) return "(no element)";
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute?.("role") ?? "";
      const ariaLabel = el.getAttribute?.("aria-label") ?? "";
      let text = "";
      if (el.textContent) text = el.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
      return `<${tag}${role ? ` role="${role}"` : ""}${ariaLabel ? ` aria-label="${ariaLabel}"` : ""}>${text}</${tag}>`;
    }, [px, py]);
  } catch {
    return "(element description failed)";
  }
}

async function clickAtCoordinates(page: Page, x: number, y: number): Promise<string> {
  const { px, py } = toPixel(x, y);
  const clickedElement = await describeElementAtPoint(page, px, py);
  await page.mouse.click(px, py);
  return clickedElement;
}

async function fillAtCoordinates(page: Page, x: number, y: number, value: string): Promise<string> {
  const { px, py } = toPixel(x, y);
  const clickedElement = await describeElementAtPoint(page, px, py);
  await page.mouse.click(px, py);
  await new Promise(r => setTimeout(r, 150));
  const filled = await page.evaluate(({ cx, cy, val }: { cx: number; cy: number; val: string }) => {
    const el = document.elementFromPoint(cx, cy) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el && ("value" in el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { cx: px, cy: py, val: value }).catch(() => false);
  if (filled) return clickedElement;
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+a" : "Control+a");
  await page.keyboard.type(value, { delay: 20 });
  return clickedElement;
}

async function clickInPage(page: Page, target: string): Promise<void> {
  const loc = page.getByText(target, { exact: false });
  if (await loc.count() > 0) {
    await loc.first().click({ timeout: 5000 });
  } else {
    const byRole = page.getByRole("button", { name: target });
    if (await byRole.count() > 0) await byRole.first().click({ timeout: 5000 });
    else throw new Error(`Target "${target}" not found`);
  }
}

async function fillInPage(page: Page, target: string, value: string): Promise<void> {
  const loc = page.getByLabel(target);
  if (await loc.count() > 0) {
    await loc.first().fill(value, { timeout: 5000 });
  } else {
    const byPlaceholder = page.getByPlaceholder(target);
    if (await byPlaceholder.count() > 0) await byPlaceholder.first().fill(value, { timeout: 5000 });
    else throw new Error(`Field "${target}" not found`);
  }
}

function formatStep(stepCounter: number, action: AgentAction, _failed: boolean): string {
  const loc = action.element != null ? `[${action.element}]` : (action.x != null ? `@(${action.x},${action.y})` : "");
  return `[${stepCounter}] ${action.action} ${loc} ${action.target ?? ""} ${action.value ?? ""}`.trim();
}

// ─── Action executor ──────────────────────────────────────────────────────────

export type ExecuteActionResult = {
  clickedElement?: string;
  clickProofScreenshot?: Buffer;
};

export async function executeAction(page: Page, action: AgentAction): Promise<ExecuteActionResult | void> {
  switch (action.action) {
    case "click": {
      if (action.x != null && action.y != null) {
        const clickedElement = await clickAtCoordinates(page, action.x, action.y);
        const clickProofScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => Buffer.alloc(0));
        await waitForPageStable(page, 4000);
        return { clickedElement, clickProofScreenshot };
      } else if (action.target) {
        await clickInPage(page, action.target);
        await waitForPageStable(page, 4000);
      } else {
        throw new Error("click requires x,y or target");
      }
      break;
    }
    case "fill": {
      if (action.x != null && action.y != null && action.value !== undefined) {
        const clickedElement = await fillAtCoordinates(page, action.x, action.y, action.value);
        const clickProofScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => Buffer.alloc(0));
        return { clickedElement, clickProofScreenshot };
      } else if (action.target && action.value !== undefined) {
        await fillInPage(page, action.target, action.value);
      } else {
        throw new Error("fill requires x,y+value or target+value");
      }
      break;
    }
    case "navigate": {
      if (!action.target?.startsWith("http")) break;
      await page.goto(action.target, { waitUntil: "domcontentloaded" });
      await waitForPageStable(page, 4000);
      break;
    }
    case "hover": {
      if (action.x != null && action.y != null) {
        const { px, py } = toPixel(action.x, action.y);
        const hoveredElement = await describeElementAtPoint(page, px, py);
        await page.mouse.move(px, py);
        await new Promise(r => setTimeout(r, 300));
        const hoverScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => Buffer.alloc(0));
        return { clickedElement: hoveredElement, clickProofScreenshot: hoverScreenshot };
      }
      throw new Error("hover requires x,y");
    }
    case "scroll": {
      const scrollDir = (action.value ?? "down 300").trim().toLowerCase();
      const match = scrollDir.match(/^(up|down|left|right)\s+(\d+)$/);
      if (!match) throw new Error(`Invalid scroll value: "${action.value}"`);
      const dir = match[1];
      const amount = Math.min(Number(match[2]), 2000);
      const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
      const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
      if (action.x != null && action.y != null) {
        const { px, py } = toPixel(action.x, action.y);
        await page.mouse.move(px, py);
      }
      await page.mouse.wheel(dx, dy);
      await new Promise(r => setTimeout(r, 300));
      break;
    }
    case "pressKey": {
      if (action.value) await page.keyboard.press(action.value);
      break;
    }
    case "selectOption": {
      if (action.x != null && action.y != null) {
        const { px, py } = toPixel(action.x, action.y);
        await page.mouse.click(px, py);
        await new Promise(r => setTimeout(r, 200));
        if (action.value) {
          await page.getByText(action.value, { exact: false }).first().click({ timeout: 3000 });
        }
      } else if (action.target && action.value) {
        const loc = page.getByLabel(action.target);
        await loc.first().selectOption({ label: action.value }, { timeout: 5000 });
      }
      break;
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitForPageStable(page, 3000);
      break;
    }
    case "dragAndDrop": {
      if (action.x == null || action.y == null || action.toX == null || action.toY == null) {
        throw new Error("dragAndDrop requires x,y (source) and toX,toY (destination)");
      }
      const src = toPixel(action.x, action.y);
      const dst = toPixel(action.toX, action.toY);
      await page.mouse.move(src.px, src.py);
      await page.mouse.down();
      await page.mouse.move(dst.px, dst.py, { steps: 10 });
      await page.mouse.up();
      await waitForPageStable(page, 3000);
      break;
    }
    case "setDate": {
      if (action.value === undefined) throw new Error("setDate requires a value (date string)");
      if (action.x != null && action.y != null) {
        const { px, py } = toPixel(action.x, action.y);
        await page.mouse.click(px, py);
      } else if (action.element != null) {
        // Handled by the a11y/stagehand resolve path upstream; fallback to target
        if (action.target) await clickInPage(page, action.target);
      }
      await page.keyboard.press("Control+a");
      await page.keyboard.type(action.value, { delay: 30 });
      await page.keyboard.press("Enter");
      await waitForPageStable(page, 2000);
      break;
    }
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export type AuthHandleResult = { ok: boolean; llmCalls: LLMCallRecord[] };

export async function handleAuth(
  page: Page,
  auth: AuthConfig | null,
  context?: string,
  baseUrl?: string,
  onLLMCall?: (call: LLMCallRecord) => void,
): Promise<AuthHandleResult> {
  if (!auth) return { ok: false, llmCalls: [] };

  // Token-based auth (Clerk, Supabase)
  if (auth.mode === "tokenProvider" && auth.tokenProvider) {
    const url = baseUrl || auth.loginUrl || page.url();
    const ok = await handleTokenAuth(page, auth.tokenProvider, url);
    return { ok, llmCalls: [] };
  }

  // API Token auth — inject header on all requests via page.route()
  if (auth.mode === "apiToken" && auth.apiTokenConfig) {
    const { token, headerName = "Authorization", headerPrefix = "Bearer" } = auth.apiTokenConfig;
    const headerValue = headerPrefix ? `${headerPrefix} ${token}` : token;
    await page.route("**/*", async (route) => {
      const headers = { ...route.request().headers(), [headerName]: headerValue };
      await route.continue({ headers });
    });
    logger.info({ headerName }, "API Token auth: header injection configured");
    return { ok: true, llmCalls: [] };
  }

  if (!auth.loginUrl || !auth.credentials) return { ok: false, llmCalls: [] };

  logger.info({ url: auth.loginUrl }, "Authenticating");
  await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  if (auth.selectors) {
    const ok = await trySelectorsAuth(page, auth);
    if (ok) {
      logger.info({ url: page.url() }, "Auth complete (selectors)");
      return { ok: true, llmCalls: [] };
    }
    logger.info({ url: auth.loginUrl }, "Selector auth failed or incomplete — falling back to Navigator (full agent)");
  }

  return await tryAgentAuthViaRunAgent(page, auth, context, baseUrl, onLLMCall);
}

async function trySelectorsAuth(page: Page, auth: AuthConfig): Promise<boolean> {
  const { usernameField, passwordField, submitButton } = auth.selectors!;
  const { username, password } = auth.credentials!;

  if (usernameField && username) {
    try {
      await page.locator(usernameField).first().fill(username, { timeout: 8000 });
    } catch (err) {
      logger.warn({ selector: "usernameField", err: String(err).split("\n")[0] }, "Auth: username selector failed");
      return false;
    }
  }
  if (passwordField && password) {
    try {
      await page.locator(passwordField).first().fill(password, { timeout: 8000 });
    } catch (err) {
      logger.warn({ selector: "passwordField", err: String(err).split("\n")[0] }, "Auth: password selector failed");
      return false;
    }
  }
  if (submitButton) {
    try {
      await page.locator(submitButton).first().click({ timeout: 8000 });
    } catch (err) {
      logger.warn({ selector: "submitButton", err: String(err).split("\n")[0] }, "Auth: submit selector failed");
      return false;
    }
  }

  await page.waitForURL(url => url.href !== auth.loginUrl!, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const finalUrl = page.url();
  return finalUrl !== auth.loginUrl!;
}

/** Full Navigator pipeline for login when CSS selectors fail or are wrong. */
async function tryAgentAuthViaRunAgent(
  page: Page,
  auth: AuthConfig,
  context: string | undefined,
  baseUrl: string | undefined,
  onLLMCall?: (call: LLMCallRecord) => void,
): Promise<AuthHandleResult> {
  const { username, password } = auth.credentials!;
  const loginIntent =
    `Log in with username "${username}" and password "${password}", then submit the login form.`;
  const authBase = auth.loginUrl || baseUrl || page.url();

  const result = await runAgent(
    page,
    loginIntent,
    authBase,
    null,
    [],
    context,
    undefined,
    undefined,
    onLLMCall,
    10,
    undefined,
    undefined,
    undefined,
  );

  const success = page.url() !== auth.loginUrl!;
  logger.info({ success, url: page.url(), status: result.status }, "Agent auth (full runAgent) complete");
  return { ok: success, llmCalls: result.llmCalls };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runAgent(
  page: Page,
  intent: string,
  baseUrl: string,
  auth: AuthConfig | null,
  memoryEntries: MemoryEntry[] = [],
  context?: string,
  onStep?: (step: RunStep) => void,
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer, domHash: string) => void,
  onLLMCall?: (call: LLMCallRecord) => void,
  maxSteps?: number,
  targetUrl?: string,
  stagehandSession?: StagehandSession,
  shouldStop?: () => boolean,
  networkMonitor?: { markActionStart: () => void; markActionEnd: () => void; formatForAgent: () => string },
): Promise<AgentResult> {
  const config = getConfig();
  const MAX_STEPS = Math.min(maxSteps ?? DEFAULT_MAX_STEPS, MAX_STEPS_HARD_CAP);
  const steps: string[] = [];
  const stepsDetail: RunStep[] = [];
  const bugsFound: RunStep[] = [];
  const failedTargets = new Set<string>();

  const llmCalls: LLMCallRecord[] = [];
  const llmCallSeq = { current: 0 };
  const handleLLMCall = (call: LLMCallRecord) => {
    llmCalls.push(call);
    onLLMCall?.(call);
  };

  let stepCounter = 0;
  const recentActions: RecentAction[] = [];
  let consecutiveLoopWarnings = 0;
  /** Spec: action repetition contributes to stuck only after 2+ consecutive iterations with repetition (pairs with consecutiveLoopWarnings in spec formula). */
  let repetitionLoopCounter = 0;
  let stagnantActions = 0;
  let pendingStagnation: { preHash: string; url: string; action: string; elementName?: string } | null = null;
  let lastStagnationContext: { action: string; elementName?: string } | null = null;

  const runTimeoutMs = config.runTimeoutMinutes * 60 * 1000;
  const runDeadline = Date.now() + runTimeoutMs;

  const stagehandPage = stagehandSession?.page ?? null;

  try {
    const authOutcome = await handleAuth(page, auth, context, baseUrl, handleLLMCall);
    if (authOutcome.ok) {
      stepCounter++;
      const authStep: RunStep = {
        index: stepCounter, action: "auth", target: auth?.loginUrl,
        reasoning: "Logged in via configured auth", url: auth?.loginUrl,
        status: "ok", fromMemory: false, at: stepTimestamp(),
      };
      stepsDetail.push(authStep);
      steps.push(`[${stepCounter}] auth \u2192 ${auth?.loginUrl} (Login complete)`);
      onStep?.(authStep);
    }

    let postAuthUrl: string | undefined;
    if (authOutcome.ok) {
      postAuthUrl = page.url();
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    } else {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    }

    if (targetUrl) {
      const currentUrl = page.url();
      if (!isSamePage(currentUrl, targetUrl)) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        stepCounter++;
        const navStep: RunStep = {
          index: stepCounter, action: "navigate", target: targetUrl,
          reasoning: "Navigate to destination page", url: page.url(),
          status: "ok", fromMemory: false, at: stepTimestamp(),
        };
        stepsDetail.push(navStep);
        steps.push(`[${stepCounter}] navigate \u2192 ${targetUrl}`);
        onStep?.(navStep);
      }
    }

    const baseSystemPrompt = buildSystemPrompt({ intent, context, memoryEntries, targetUrl });
    const progress = new ProgressSummary();
    const agentBugTracker: RunStep[] = [];
    let agentPlan: AgentPlanItem[] = [];
    let consecutiveMetaActions = 0;
    const messages: any[] = [
      { role: "system", content: baseSystemPrompt },
    ];
    let prevResult: {
      action: AgentAction;
      status: "ok" | "failed";
      error?: string;
      clickedElement?: string;
      clickProofScreenshot?: Buffer;
    } | undefined;

    let prevUrl = "";
    let currentElements: A11yElement[] | undefined;
    let currentObserved: ObservedElement[] | undefined;
    let prevDomHash = "";  // Track DOM changes to skip redundant screenshots

    for (let i = 0; i < MAX_STEPS; i++) {
      logger.info(
        { loopIteration: i + 1, maxIterations: MAX_STEPS, recordedStepCount: stepCounter, url: page.url() },
        "Navigator loop iteration",
      );
      // Refresh token if expiring soon (Clerk ~60s, Supabase ~3600s)
      await refreshIfNeeded(page);

      const currentUrl = page.url();

      if (prevUrl && !isSamePage(currentUrl, prevUrl)) {
        recentActions.length = 0;
        consecutiveLoopWarnings = 0;
        stagnantActions = 0;
        pendingStagnation = null;
        lastStagnationContext = null;
        repetitionLoopCounter = 0;
      }
      prevUrl = currentUrl;

      if (Date.now() > runDeadline) {
        steps.push(`[TIMEOUT] Run exceeded ${config.runTimeoutMinutes}-minute limit`);
        return { status: "failed", steps, stepsDetail, bugsFound, llmCalls, failReason: `Run timed out` };
      }

      if (shouldStop?.()) {
        steps.push(`[STOPPED] Run stopped by user`);
        return { status: "failed", steps, stepsDetail, bugsFound, llmCalls, failReason: "Stopped by user" };
      }

      const snapshot = await takeStableSnapshot(page, stagehandPage);
      const { screenshot, cleanScreenshot, dom, url, title, pageText } = snapshot;
      currentElements = snapshot.a11yElements;
      currentObserved = snapshot.observedElements;

      if (screenshot.length === 0 && dom === "(DOM extraction failed)") break;
      // Skip sending screenshot when page content is unchanged (saves vision tokens)
      const domHash = simpleDomHash(url, dom);
      const preActionDomHash = domHash;

      if (pendingStagnation) {
        if (pendingStagnation.url === currentUrl && domHash === pendingStagnation.preHash) {
          // Backoff retry: before counting a stagnation, wait progressively and re-check DOM.
          // This catches slow async updates (API calls, animations, debounced renders).
          const backoffMs = stagnantActions === 0 ? 1000 : stagnantActions === 1 ? 2000 : 0;
          let stillStagnant = true;
          if (backoffMs > 0) {
            await new Promise(r => setTimeout(r, backoffMs));
            const recheckDom = await page.evaluate(() => document.body?.innerHTML?.length ?? 0).catch(() => -1);
            const recheckHash = simpleDomHash(page.url(), String(recheckDom));
            if (recheckHash !== pendingStagnation.preHash) {
              stillStagnant = false;
            }
          }
          if (stillStagnant) {
            stagnantActions++;
            lastStagnationContext = {
              action: pendingStagnation.action,
              elementName: pendingStagnation.elementName,
            };
          } else {
            stagnantActions = 0;
            lastStagnationContext = null;
          }
        } else {
          stagnantActions = 0;
          lastStagnationContext = null;
        }
        pendingStagnation = null;
      }

      if (screenshot.length > 0) {
        onScreenshot?.(screenshot, cleanScreenshot, domHash);
      }
      prevDomHash = domHash;
      if (dom === "(DOM extraction failed)") continue;

      const loopResult = detectActionRepetition(recentActions);
      const repetitionStuck = loopResult.stuck;
      const stagnationStuck = stagnantActions >= 2;
      // Spec: stuck = stagnantActions >= 2 OR (actionRepetition >= 3 AND consecutive repetition warnings >= 1)
      // → repetition path needs 2 consecutive iterations with repetition detected (counter >= 2 after increment).
      if (repetitionStuck) {
        repetitionLoopCounter++;
      } else {
        repetitionLoopCounter = 0;
      }
      const stuckSignal = stagnationStuck || (repetitionStuck && repetitionLoopCounter >= 2);

      if (stuckSignal) {
        consecutiveLoopWarnings++;
        if (consecutiveLoopWarnings >= LOOP_FORCE_EXIT_AFTER) {
          const bugStep: RunStep = {
            index: ++stepCounter,
            action: "bug",
            reasoning: `Repeated action with no page state change: ${loopResult.repeatedKey ?? lastStagnationContext?.action ?? "dom stagnation"}`,
            url: page.url(),
            status: "ok",
            fromMemory: false,
            bugType: "functional",
            severity: "high",
            source: "navigator",
            at: stepTimestamp(),
          };
          stepsDetail.push(bugStep);
          onStep?.(bugStep);
          const forcedDone: RunStep = {
            index: ++stepCounter,
            action: "done",
            reasoning: "Forced exit: agent stuck in loop",
            url: page.url(),
            status: "failed",
            fromMemory: false,
            at: stepTimestamp(),
            doneResult: "blocked",
          };
          stepsDetail.push(forcedDone);
          onStep?.(forcedDone);
          return {
            status: "failed",
            steps,
            stepsDetail,
            bugsFound,
            llmCalls,
            failReason: "Agent stuck in loop",
          };
        }
      } else {
        consecutiveLoopWarnings = 0;
      }

      const planState = formatAgentPlanState(agentPlan);
      const bugTrackerState = formatBugTrackerState(agentBugTracker);

      const observation = buildObservation({
        url, title, dom, screenshot, pageText,
        failedTargets: Array.from(failedTargets),
        stuckWarning: stuckSignal,
        targetUrl,
        prevResult,
        planState: planState || undefined,
        bugTrackerState,
        domStagnationAdvisory: stagnantActions >= 1 && lastStagnationContext ? lastStagnationContext : undefined,
        repetitionLoopAdvisory: repetitionStuck,
        repeatedKey: loopResult.repeatedKey,
        networkHint: networkMonitor?.formatForAgent() || undefined,
      });
      messages.push({ role: "user", content: observation });

      // Inject rolling progress summary into system prompt (survives pruning)
      const progressText = progress.format();
      messages[0].content = progressText
        ? `${baseSystemPrompt}\n\n${progressText}`
        : baseSystemPrompt;

      logger.info(
        {
          recordedStepCount: stepCounter,
          loopIteration: i + 1,
          url: page.url(),
          chatMessages: messages.length,
          consecutiveMetaActions,
        },
        "Navigator: calling LLM for next action",
      );

      let action: AgentAction;
      try {
        action = await decideNextAction({
          messages, stepIndex: stepCounter + 1, llmCallSeq,
          onLLMCall: handleLLMCall,
        });
        messages.push({ role: "assistant", content: JSON.stringify(action) });
        logger.info(
          {
            action: action.action,
            recordedStepCount: stepCounter,
            reasoningPreview: (action.reasoning ?? "").slice(0, 160),
          },
          "Navigator: LLM returned action",
        );
      } catch (err) {
        logger.warn(
          { err: String(err), recordedStepCount: stepCounter, loopIteration: i + 1 },
          "Navigator: LLM decision failed; will retry next iteration",
        );
        messages.pop();
        prevResult = undefined;
        continue;
      }

      const actionError = validateAction(action);
      if (actionError) {
        let fixed = false;
        for (let retry = 0; retry < 2; retry++) {
          const correction = buildCorrectionPrompt(action, actionError);
          messages.push({ role: "user", content: correction });
          try {
            action = await decideNextAction({
              messages, stepIndex: stepCounter + 1, llmCallSeq,
              onLLMCall: handleLLMCall,
            });
            messages.push({ role: "assistant", content: JSON.stringify(action) });
            if (!validateAction(action)) { fixed = true; break; }
          } catch {
            messages.pop();
            break;
          }
        }
        if (!fixed && validateAction(action)) {
          prevResult = undefined;
          continue;
        }
      }

      if (action.action === "wait") {
        consecutiveMetaActions = 0;
        const ms = Math.min(Number(action.value) || 1000, 5000);
        await new Promise((r) => setTimeout(r, ms));
        prevResult = undefined;
        continue;
      }

      if (action.action === "observe" || action.action === "plan" || action.action === "report_bug") {
        consecutiveMetaActions++;
        logger.info(
          { metaAction: action.action, consecutiveMetaActions, recordedStepCount: stepCounter },
          "Navigator: meta-action (no step increment)",
        );
        if (consecutiveMetaActions > MAX_META_ACTIONS) {
          logger.warn(
            { consecutiveMetaActions, max: MAX_META_ACTIONS },
            "Navigator: meta-action cap; prompting for page action",
          );
          messages.push({
            role: "user",
            content: "Too many consecutive meta-actions (observe/plan/report_bug). Take a concrete page action or call done.",
          });
          prevResult = undefined;
          continue;
        }
        if (action.action === "plan") {
          const nextPlan = normalizePlanItems(action.planItems);
          if (nextPlan.length > 0) {
            agentPlan = nextPlan;
          }
        } else if (action.action === "report_bug") {
          const bugStep: RunStep = {
            index: stepCounter + 1 + agentBugTracker.length,
            action: "bug",
            reasoning: action.bugDescription?.trim() || "Navigator-reported bug",
            url,
            status: "ok",
            fromMemory: false,
            at: stepTimestamp(),
            bugType: action.bugType ?? "functional",
            severity: action.severity ?? "medium",
            source: "navigator",
            screenshotBase64: cleanScreenshot.length > 0 ? cleanScreenshot.toString("base64") : undefined,
          };
          agentBugTracker.push(bugStep);
          bugsFound.push(bugStep);
          progress.recordBug(bugStep.reasoning ?? "Navigator bug");
        }
        prevResult = undefined;
        continue;
      }
      consecutiveMetaActions = 0;

      stepCounter++;
      let elementName: string | undefined;
      if (action.element != null) {
        elementName = currentElements?.find(e => e.id === action.element)?.name
          ?? currentObserved?.find(e => e.id === action.element)?.description;
      }
      recentActions.push({ action: action.action, x: action.x, y: action.y, target: action.target, element: action.element, elementName, value: action.value, assertion: action.assertion, url });
      if (recentActions.length > LOOP_WINDOW) recentActions.shift();

      const desc = formatStep(stepCounter, action, false);
      steps.push(desc);

      if (action.action === "done") {
        const raw = action.result ?? "completed";
        const dr: DoneResult = raw === "blocked" ? "blocked" : "completed";
        const doneStep: RunStep = {
          index: stepCounter, action: "done", reasoning: action.reasoning,
          url, status: "ok", fromMemory: false, at: stepTimestamp(),
          doneResult: dr,
          observation: action.observation,
        };
        stepsDetail.push(doneStep);
        onStep?.(doneStep);
        const status = doneResultToStatus(dr);
        return {
          status,
          steps,
          stepsDetail,
          bugsFound,
          llmCalls,
          failReason: dr === "blocked" ? (action.reasoning ?? "Navigator reported blocked") : undefined,
        };
      }

      let stepExecutionMethod: RunStep["executionMethod"] | undefined;
      networkMonitor?.markActionStart();
      try {
        // Stagehand execution path
        const shInstruction = (stagehandPage && currentObserved)
          ? actionToInstruction(action, currentObserved) : null;

        if (shInstruction && stagehandPage) {
          stepExecutionMethod = "stagehand";
          await stagehandAct(stagehandPage, shInstruction);
          await waitForPageStable(page, 4000);
          prevResult = { action, status: "ok" };

          const observedEl = action.element != null ? currentObserved?.find(e => e.id === action.element) : null;
          const okStep: RunStep = {
            index: stepCounter, action: action.action, element: action.element,
            target: action.target ?? observedEl?.description, value: action.value,
            assertion: action.assertion, reasoning: action.reasoning,
            url, status: "ok", fromMemory: false, at: stepTimestamp(),
            domContext: trimDomContext(dom),
            executionMethod: "stagehand",
            observation: action.observation,
            preActionDomHash: preActionDomHash,
          };
          stepsDetail.push(okStep);
          onStep?.(okStep);
          if (MUTATING_ACTIONS.has(action.action)) {
            pendingStagnation = {
              preHash: preActionDomHash,
              url: currentUrl,
              action: action.action,
              elementName,
            };
          }
          networkMonitor?.markActionEnd();
          continue;
        }

        // Native execution path
        let resolvedA11yEl: A11yElement | undefined;
        if (action.element != null && currentElements) {
          resolvedA11yEl = currentElements.find(e => e.id === action.element);
          if (resolvedA11yEl) {
            const locator = await resolveElement(page, resolvedA11yEl);
            if (locator) {
              stepExecutionMethod = "playwright";
              if (action.action === "click") {
                await locator.click({ timeout: 5000 });
                await waitForPageStable(page, 4000);
              } else if (action.action === "fill" && action.value !== undefined) {
                await locator.fill(action.value, { timeout: 5000 });
              } else if (action.action === "selectOption" && action.value) {
                await locator.selectOption({ label: action.value }, { timeout: 5000 }).catch(async () => {
                  await locator.click({ timeout: 3000 });
                  await page.getByText(action.value!, { exact: false }).first().click({ timeout: 3000 });
                });
              } else {
                await executeAction(page, action);
              }
              prevResult = { action, status: "ok" };
              const okStep: RunStep = {
                index: stepCounter, action: action.action, element: action.element,
                target: action.target ?? resolvedA11yEl.name, value: action.value,
                assertion: action.assertion, reasoning: action.reasoning,
                url, status: "ok", fromMemory: false, at: stepTimestamp(),
                elementRef: { role: resolvedA11yEl.role, name: resolvedA11yEl.name },
                domContext: trimDomContext(dom),
                executionMethod: "playwright",
                observation: action.observation,
                preActionDomHash: preActionDomHash,
              };
              stepsDetail.push(okStep);
              onStep?.(okStep);
              if (MUTATING_ACTIONS.has(action.action)) {
                pendingStagnation = {
                  preHash: preActionDomHash,
                  url: currentUrl,
                  action: action.action,
                  elementName,
                };
              }
              networkMonitor?.markActionEnd();
              continue;
            }
          }
        }

        stepExecutionMethod = executionUsesCoordinates(action) ? "coordinates" : "playwright";
        const execResult = await executeAction(page, action);
        await new Promise((r) => setTimeout(r, 150));
        prevResult = {
          action, status: "ok",
          ...(execResult && {
            clickedElement: execResult.clickedElement,
            clickProofScreenshot: execResult.clickProofScreenshot,
          }),
        };

        const okStep: RunStep = {
          index: stepCounter, action: action.action, element: action.element,
          target: action.target, value: action.value,
          x: action.x, y: action.y,
          assertion: action.assertion, reasoning: action.reasoning,
          url, status: "ok", fromMemory: false, at: stepTimestamp(),
          elementRef: resolvedA11yEl ? { role: resolvedA11yEl.role, name: resolvedA11yEl.name } : undefined,
          domContext: trimDomContext(dom),
          executionMethod: stepExecutionMethod,
          observation: action.observation,
          preActionDomHash: preActionDomHash,
        };
        stepsDetail.push(okStep);
        progress.recordStep(okStep);
        onStep?.(okStep);
        if (MUTATING_ACTIONS.has(action.action)) {
          pendingStagnation = {
            preHash: preActionDomHash,
            url: currentUrl,
            action: action.action,
            elementName,
          };
        }
        networkMonitor?.markActionEnd();
      } catch (err) {
        networkMonitor?.markActionEnd();
        const errMsg = String(err).split("\n")[0];
        steps.push(`  \u21B3 failed: ${errMsg}`);
        prevResult = { action, status: "failed", error: errMsg };

        const failedStep: RunStep = {
          index: stepCounter, action: action.action,
          target: action.target, value: action.value,
          x: action.x, y: action.y,
          assertion: action.assertion, reasoning: action.reasoning,
          url, status: "failed", error: errMsg, fromMemory: false, at: stepTimestamp(),
          domContext: trimDomContext(dom),
          executionMethod: stepExecutionMethod ?? "playwright",
          observation: action.observation,
          preActionDomHash: preActionDomHash,
        };
        stepsDetail.push(failedStep);
        progress.recordStep(failedStep);
        onStep?.(failedStep);
        if (action.target) failedTargets.add(action.target);
        pendingStagnation = null;
      }
    }

    steps.push(`[LIMIT] Reached ${MAX_STEPS}-step limit`);
    const limitDone: RunStep = {
      index: ++stepCounter,
      action: "done",
      reasoning: `Reached ${MAX_STEPS}-step limit`,
      url: page.url(),
      status: "ok",
      fromMemory: false,
      at: stepTimestamp(),
      doneResult: "blocked",
    };
    stepsDetail.push(limitDone);
    onStep?.(limitDone);
    return {
      status: "failed",
      steps,
      stepsDetail,
      bugsFound,
      llmCalls,
      failReason: `Exceeded ${MAX_STEPS} steps`,
    };

  } catch (err) {
    return { status: "failed", steps, stepsDetail, bugsFound, llmCalls, failReason: String(err) };
  }
}
