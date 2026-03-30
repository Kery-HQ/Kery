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
import { PlanTracker } from "./planTracker.js";
import { handleTokenAuth, refreshIfNeeded } from "./tokenAuth.js";
import {
  stagehandObserve, formatObserveForLLM, hasSufficientObserve,
  stagehandAct, actionToInstruction, isObserveCircuitOpen,
  type ObservedElement, type StagehandSession,
} from "./stagehandBridge.js";

export type AgentAction = {
  action: "fill" | "click" | "navigate" | "assert" | "wait" | "done"
    | "hover" | "scroll" | "pressKey" | "selectOption" | "back";
  element?: number;
  target?: string;
  value?: string;
  x?: number;
  y?: number;
  assertion?: string;
  reasoning?: string;
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
  /** How the action was executed */
  executionMethod?: "stagehand" | "playwright" | "coordinates";
  /** Review-agent bugs attached to this step (set by orchestrator) */
  reviewFeedback?: { type: string; severity: string; description: string }[];
};

export type LLMAgentType =
  | "navigator"
  | "review"
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
  status: "passed" | "failed" | "partial";
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
const LOOP_WINDOW = 4;
const LOOP_THRESHOLD = 2;
const COORD_PROXIMITY = 50;

type RecentAction = { action: string; x?: number; y?: number; target?: string; element?: number; elementName?: string; value?: string; assertion?: string; url?: string };

const LOOP_EXEMPT_ACTIONS = new Set(["assert", "wait"]);

function detectLoop(recent: RecentAction[]): { stuck: boolean; repeatedKey?: string; repeatCount?: number } {
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
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    // Best-effort
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
  if (stagehand && !isObserveCircuitOpen()) {
    observedElements = await stagehandObserve(stagehand);
    if (hasSufficientObserve(observedElements)) {
      const dom = formatObserveForLLM(observedElements);
      const pageText = await extractVisibleText(page);
      return { screenshot: cleanScreenshot, cleanScreenshot, dom, url, title, pageText, observedElements };
    }
  }

  // Try a11y tree
  const { elements: a11yElements, textNodes: a11yTextNodes } = await extractA11yTree(page);
  if (hasSufficientA11y(a11yElements)) {
    await injectElementMarkers(page, a11yElements);
    const markedScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => cleanScreenshot);
    await removeElementMarkers(page);
    const dom = formatA11yForLLM(a11yElements, a11yTextNodes);
    const pageText = await extractVisibleText(page);
    return { screenshot: markedScreenshot, cleanScreenshot, dom, url, title, pageText, a11yElements, a11yTextNodes };
  }

  // Fallback to DOM extraction
  const { text: dom } = await extractDOM(page);
  const pageText = await extractVisibleText(page);
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

FALLBACK: If an element is not in the list, use x,y coordinates (integers 0-1000) instead.

ACTIONS:
- click: Click element [N] or at x,y
- fill: Fill element [N] with value
- pressKey: Press keyboard key (Tab, Enter, Escape, ArrowDown)
- selectOption: Select option in element [N] by label in "value"
- scroll: Scroll the page (use "value" as "down 300" or "up 500", optional x,y for specific element)
- hover: Move pointer to x,y without clicking (reveal tooltips, verify aim)
- navigate: Go to a URL (provide full URL in "target")
- assert: Verify text is visible on page (provide text in "assertion")
- back: Browser back
- wait: Wait for async operations (value = milliseconds, max 5000)
- done: Task complete

RULES:
- Follow the plan step by step
- Don't fill fields that already have the correct value (check the "value" shown in the element list)
- A disabled element cannot be interacted with \u2014 change something first
- If stuck after 3 attempts, try a different approach or call done
- "done" only when intent fully complete
- Auth in conversation history = already logged in, skip re-login
- If on wrong page, use navigate to go directly to the target URL

ERROR RECOVERY:
- If an action fails twice, try a different approach: use a different selector, navigate to the page again, or try a keyboard-based alternative (Tab + Enter instead of click).

FORM VALIDATION TESTING:
- When testing forms, try submitting with empty required fields first, then with invalid values (e.g., 'not-an-email' for email fields), before testing the happy path.

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
  stuckHint?: string;
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

  if (params.stuckWarning) {
    if (params.targetUrl) {
      parts.push(`LOOP DETECTED: You repeated the same action 3+ times. You MUST stay on this page (${params.targetUrl}). Try: scroll to find new elements, click something you haven't tried yet, or call "done" if you've tested enough.`);
    } else {
      parts.push(`LOOP DETECTED: You repeated the same action 3+ times. Try a completely different approach \u2014 navigate elsewhere, click something different, or call "done".`);
    }
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

// ─── Conversation pruning ─────────────────────────────────────────────────────

const KEEP_FULL_TURNS = 5;

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
      costUsd: calcCostUsd(getConfig().agentModel, usage.inputTokens, usage.outputTokens),
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
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function handleAuth(page: Page, auth: AuthConfig | null, context?: string, baseUrl?: string): Promise<boolean> {
  if (!auth) return false;

  // Token-based auth (Clerk, Supabase)
  if (auth.mode === "tokenProvider" && auth.tokenProvider) {
    const url = baseUrl || auth.loginUrl || page.url();
    return handleTokenAuth(page, auth.tokenProvider, url);
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
    return true;
  }

  if (!auth.loginUrl || !auth.credentials) return false;

  logger.info({ url: auth.loginUrl }, "Authenticating");
  await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  if (auth.selectors) {
    const ok = await trySelectorsAuth(page, auth);
    if (ok) {
      logger.info({ url: page.url() }, "Auth complete (selectors)");
      return true;
    }
  }

  return await tryAgentAuth(page, auth, context);
}

async function trySelectorsAuth(page: Page, auth: AuthConfig): Promise<boolean> {
  const { usernameField, passwordField, submitButton } = auth.selectors!;
  const { username, password } = auth.credentials!;

  if (usernameField && username) {
    try { await page.locator(usernameField).first().fill(username, { timeout: 8000 }); }
    catch { return false; }
  }
  if (passwordField && password) {
    try { await page.locator(passwordField).first().fill(password, { timeout: 8000 }); }
    catch { return false; }
  }
  if (submitButton) {
    try { await page.locator(submitButton).first().click({ timeout: 8000 }); }
    catch { return false; }
  }

  await page.waitForURL(url => url.href !== auth.loginUrl!, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const finalUrl = page.url();
  return finalUrl !== auth.loginUrl!;
}

async function tryAgentAuth(page: Page, auth: AuthConfig, context?: string): Promise<boolean> {
  const { username, password } = auth.credentials!;
  const intent = `Fill the login form with credentials: username "${username}", password "${password}", then submit to log in.`;

  const messages: any[] = [
    { role: "system", content: buildSystemPrompt({ intent, context, memoryEntries: [] }) },
  ];
  let prevResult: { action: AgentAction; status: "ok" | "failed"; error?: string } | undefined;

  for (let i = 0; i < 8; i++) {
    const { screenshot, dom, url, title } = await takeStableSnapshot(page);
    if (dom === "(DOM extraction failed)") continue;

    const observation = buildObservation({
      url, title, dom, screenshot,
      failedTargets: [],
      prevResult,
    });
    messages.push({ role: "user", content: observation });

    let action: AgentAction;
    try {
      action = await decideNextAction({
        messages,
        stepIndex: i + 1,
        llmCallSeq: { current: 0 },
        onLLMCall: () => {},
      });
      messages.push({ role: "assistant", content: JSON.stringify(action) });
    } catch {
      messages.pop();
      prevResult = undefined;
      continue;
    }

    if (action.action === "done") break;
    if (action.action === "wait") {
      await new Promise(r => setTimeout(r, Math.min(Number(action.value) || 1000, 5000)));
      prevResult = undefined;
      continue;
    }

    try {
      await executeAction(page, action);
      await waitForPageStable(page, 4000);
      prevResult = { action, status: "ok" };
    } catch (err) {
      prevResult = { action, status: "failed", error: String(err).split("\n")[0] };
    }

    const postActionUrl = page.url();
    if (postActionUrl !== auth.loginUrl) {
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      break;
    }
  }

  const finalUrl = page.url();
  const success = finalUrl !== auth.loginUrl!;
  logger.info({ success, url: finalUrl }, "Agent auth complete");
  return success;
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
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer) => void,
  onLLMCall?: (call: LLMCallRecord) => void,
  maxSteps?: number,
  targetUrl?: string,
  stagehandSession?: StagehandSession,
  shouldStop?: () => boolean,
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

  const runTimeoutMs = config.runTimeoutMinutes * 60 * 1000;
  const runDeadline = Date.now() + runTimeoutMs;

  const stagehandPage = stagehandSession?.page ?? null;

  try {
    const authed = await handleAuth(page, auth, context, baseUrl);
    if (authed) {
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
    if (authed) {
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

    let planTracker: PlanTracker | undefined;
    if (context) {
      const planStepRegex = /^\s*\d+\.\s+(\w+)\s+"([^"]+)"/gm;
      const planSteps: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = planStepRegex.exec(context)) !== null) {
        planSteps.push(`${match[1]} "${match[2]}"`);
      }
      if (planSteps.length >= 2) {
        planTracker = PlanTracker.fromDescriptions(planSteps);
      }
    }

    const baseSystemPrompt = buildSystemPrompt({ intent, context, memoryEntries, targetUrl });
    const progress = new ProgressSummary();
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
      // Refresh token if expiring soon (Clerk ~60s, Supabase ~3600s)
      await refreshIfNeeded(page);

      const currentUrl = page.url();

      if (prevUrl && !isSamePage(currentUrl, prevUrl)) {
        recentActions.length = 0;
        consecutiveLoopWarnings = 0;
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
      if (screenshot.length > 0 && domHash !== prevDomHash) {
        onScreenshot?.(screenshot, cleanScreenshot);
      }
      prevDomHash = domHash;
      if (dom === "(DOM extraction failed)") continue;

      const loopResult = detectLoop(recentActions);
      if (loopResult.stuck) {
        consecutiveLoopWarnings++;
        if (consecutiveLoopWarnings >= 2) {
          const doneStep: RunStep = {
            index: ++stepCounter, action: "done", reasoning: "Forced exit: agent stuck in loop",
            url: page.url(), status: "ok", fromMemory: false, at: stepTimestamp(),
          };
          stepsDetail.push(doneStep);
          onStep?.(doneStep);
          return { status: "passed", steps, stepsDetail, bugsFound, llmCalls };
        }
      } else {
        consecutiveLoopWarnings = 0;
      }

      if (planTracker) {
        await planTracker.evaluate(page);
        if (planTracker.isComplete()) {
          const doneStep: RunStep = {
            index: ++stepCounter, action: "done", reasoning: "All plan steps completed",
            url: page.url(), status: "ok", fromMemory: false, at: stepTimestamp(),
          };
          stepsDetail.push(doneStep);
          onStep?.(doneStep);
          return { status: "passed", steps, stepsDetail, bugsFound, llmCalls };
        }
      }

      const planState = planTracker?.formatForLLM();
      const stuckHint = planTracker?.getStuckHint();

      const observation = buildObservation({
        url, title, dom, screenshot, pageText,
        failedTargets: Array.from(failedTargets),
        stuckWarning: loopResult.stuck,
        targetUrl,
        prevResult,
        planState: planState || undefined,
        stuckHint: stuckHint || undefined,
      });
      messages.push({ role: "user", content: observation });

      // Inject rolling progress summary into system prompt (survives pruning)
      const progressText = progress.format();
      messages[0].content = progressText
        ? `${baseSystemPrompt}\n\n${progressText}`
        : baseSystemPrompt;

      let action: AgentAction;
      try {
        action = await decideNextAction({
          messages, stepIndex: stepCounter + 1, llmCallSeq,
          onLLMCall: handleLLMCall,
        });
        messages.push({ role: "assistant", content: JSON.stringify(action) });
      } catch (err) {
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
        const ms = Math.min(Number(action.value) || 1000, 5000);
        await new Promise((r) => setTimeout(r, ms));
        prevResult = undefined;
        continue;
      }

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
        const doneStep: RunStep = {
          index: stepCounter, action: "done", reasoning: action.reasoning,
          url, status: "ok", fromMemory: false, at: stepTimestamp(),
        };
        stepsDetail.push(doneStep);
        onStep?.(doneStep);
        return { status: "passed", steps, stepsDetail, bugsFound, llmCalls };
      }

      let stepExecutionMethod: RunStep["executionMethod"] | undefined;
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
          };
          stepsDetail.push(okStep);
          onStep?.(okStep);
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
              };
              stepsDetail.push(okStep);
              onStep?.(okStep);
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
        };
        stepsDetail.push(okStep);
        progress.recordStep(okStep);
        onStep?.(okStep);
      } catch (err) {
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
        };
        stepsDetail.push(failedStep);
        progress.recordStep(failedStep);
        onStep?.(failedStep);
        if (action.target) failedTargets.add(action.target);
      }
    }

    steps.push(`[LIMIT] Reached ${MAX_STEPS}-step limit`);
    const meaningfulActions = stepsDetail.filter(s => ['click', 'fill', 'selectOption', 'pressKey'].includes(s.action) && s.status === "ok");
    const hasFailedAssertions = stepsDetail.some(s => s.action === "assert" && s.status === "failed");
    const hasFailedSteps = stepsDetail.some(s => s.status === "failed");
    const status = (meaningfulActions.length >= 3 && !hasFailedAssertions) || bugsFound.length > 0 || !hasFailedSteps ? "passed" : "failed";
    return { status, steps, stepsDetail, bugsFound, llmCalls, failReason: status === "failed" ? `Exceeded ${MAX_STEPS} steps` : undefined };

  } catch (err) {
    return { status: "failed", steps, stepsDetail, bugsFound, llmCalls, failReason: String(err) };
  }
}
