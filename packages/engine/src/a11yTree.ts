/**
 * Accessibility Tree extraction, formatting, and element resolution.
 *
 * Replaces the custom DOM_EXTRACT_SCRIPT with the browser's accessibility tree.
 * Elements get integer IDs referenced by the LLM as [1], [2], [3] instead of
 * coordinate-based (x,y) interaction.
 */
import type { Page, Locator } from "playwright";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type A11yElement = {
  id: number;
  role: string;
  name: string;
  state: string[];
  value?: string;
  bbox?: { x: number; y: number; width: number; height: number };
};

type A11yNode = {
  role: string;
  name: string;
  value?: string;
  description?: string;
  focused?: boolean;
  disabled?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  pressed?: boolean | "mixed";
  level?: number;
  children?: A11yNode[];
};

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "combobox", "searchbox",
  "checkbox", "radio", "switch", "slider", "spinbutton",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "cell", "gridcell",
  // Previously missing roles
  "listbox", "menu", "menubar", "toolbar", "tree",
  "dialog", "alertdialog", "progressbar", "meter",
  "scrollbar", "separator", "tablist", "tabpanel",
  "application", "document", "form",
]);

const TEXT_ROLES = new Set([
  "heading", "paragraph", "listitem", "status", "alert",
  "blockquote", "caption", "contentinfo", "definition",
  "note", "tooltip", "log",
]);

// ─── A11y Tree Cache ─────────────────────────────────────────────────────────

type A11yCacheEntry = {
  elements: A11yElement[];
  textNodes: A11yTextNode[];
  tree: A11yNode[];
};

const a11yCache = new Map<string, A11yCacheEntry>();
const A11Y_CACHE_MAX = 20;

/** Clear the a11y cache (call between runs). */
export function clearA11yCache(): void {
  a11yCache.clear();
}

// ─── Extract A11y Tree ───────────────────────────────────────────────────────

const A11Y_EXTRACT_SCRIPT = `(function() {
  function getImplicitRole(el) {
    var tag = el.tagName;
    if (tag === "BUTTON") return "button";
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "INPUT") {
      var type = el.type || "text";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "heading";
    if (tag === "P") return "paragraph";
    if (tag === "LI") return "listitem";
    if (tag === "BLOCKQUOTE") return "blockquote";
    if (tag === "FIGCAPTION") return "caption";
    if (tag === "SUMMARY") return "button";
    if (tag === "DETAILS") return "group";
    if (tag === "DIALOG") return "dialog";
    if (tag === "METER") return "meter";
    if (tag === "PROGRESS") return "progressbar";
    if (tag === "NAV") return "navigation";
    // Custom interactive elements: onclick, tabindex, contenteditable
    if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return "textbox";
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && parseInt(el.getAttribute("tabindex")) >= 0)) {
      // Check for cursor:pointer as additional clickability signal
      try {
        var style = window.getComputedStyle(el);
        if (style.cursor === "pointer" || el.hasAttribute("onclick")) return "button";
      } catch(e) {}
      return "button";
    }
    return "";
  }

  function getAccessibleName(el) {
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().slice(0, 60);
    var ariaLabelledBy = el.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      var labelEl = document.getElementById(ariaLabelledBy);
      if (labelEl) return (labelEl.textContent || "").trim().slice(0, 60);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      var id = el.id;
      if (id) {
        var label = document.querySelector('label[for="' + id + '"]');
        if (label) return (label.textContent || "").trim().slice(0, 60);
      }
      var closestLabel = el.closest("label");
      if (closestLabel) return (closestLabel.textContent || "").trim().slice(0, 60);
      var placeholder = el.placeholder;
      if (placeholder) return placeholder.slice(0, 60);
    }
    if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button")) {
      return (el.value || "Submit").slice(0, 60);
    }
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    return text.slice(0, 60);
  }

  function buildTree(el) {
    var role = getImplicitRole(el);
    var name = getAccessibleName(el);
    var node = { role: role, name: name };

    if (el.disabled || el.getAttribute("aria-disabled") === "true") node.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") node.required = true;
    if (el.getAttribute("aria-checked") === "true") node.checked = true;
    if (el.getAttribute("aria-checked") === "mixed") node.checked = "mixed";
    if (el.getAttribute("aria-expanded") === "true") node.expanded = true;
    if (el.getAttribute("aria-expanded") === "false") node.expanded = false;
    if (el.getAttribute("aria-selected") === "true") node.selected = true;
    if (el.getAttribute("aria-pressed") === "true") node.pressed = true;
    if (el.value && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      node.value = el.value.slice(0, 50);
    }

    var children = [];
    for (var i = 0; i < el.children.length; i++) {
      var childNode = buildTree(el.children[i]);
      if (childNode) children.push(childNode);
    }
    if (children.length > 0) node.children = children;

    if (role || children.length > 0) return node;
    return null;
  }

  return JSON.stringify(buildTree(document.body));
})()`;

export type A11yTextNode = {
  role: string;
  name: string;
};

export async function extractA11yTree(page: Page, domHash?: string): Promise<{ elements: A11yElement[]; textNodes: A11yTextNode[]; tree: A11yNode[] }> {
  // Return cached result when DOM hash is unchanged
  if (domHash && a11yCache.has(domHash)) {
    logger.debug({ domHash }, "A11y tree cache hit");
    return a11yCache.get(domHash)!;
  }
  const elements: A11yElement[] = [];
  const textNodes: A11yTextNode[] = [];
  let nextId = 1;

  try {
    const raw = await page.evaluate(A11Y_EXTRACT_SCRIPT) as string;
    const snapshot = raw ? JSON.parse(raw) : null;

    // Also extract from iframes (e.g. Clerk, Stripe, etc.)
    const iframeSnapshots: any[] = [];
    let iframeCount = 0;
    let iframeSuccessCount = 0;
    let iframeFailCount = 0;
    try {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        iframeCount++;
        const frameUrl = frame.url();
        try {
          const frameRaw = await frame.evaluate(A11Y_EXTRACT_SCRIPT).catch(() => null) as string | null;
          if (frameRaw) {
            const parsed = JSON.parse(frameRaw);
            if (parsed) {
              iframeSnapshots.push(parsed);
              iframeSuccessCount++;
            }
          } else {
            iframeFailCount++;
            logger.warn({ frameUrl: frameUrl?.slice(0, 120) }, "A11y iframe extraction returned null — frame may be cross-origin or empty");
          }
        } catch (frameErr) {
          iframeFailCount++;
          logger.warn({ frameUrl: frameUrl?.slice(0, 120), err: String(frameErr).slice(0, 150) }, "A11y iframe extraction failed — frame inaccessible");
        }
      }
    } catch (framesErr) {
      logger.warn({ err: String(framesErr).slice(0, 150) }, "Failed to enumerate page frames");
    }
    if (iframeCount > 0) {
      logger.info({ iframeCount, iframeSuccessCount, iframeFailCount }, "Iframe a11y extraction summary");
    }

    if (!snapshot && iframeSnapshots.length === 0) return { elements, textNodes, tree: [] };

    const walk = (node: any) => {
      if (!node) return;
      const role = node.role ?? "";
      const name = (node.name ?? "").trim();

      if (INTERACTIVE_ROLES.has(role) && (name || role === "textbox")) {
        const state: string[] = [];
        if (node.disabled) state.push("disabled");
        if (node.required) state.push("required");
        if (node.checked === true) state.push("checked");
        if (node.checked === "mixed") state.push("mixed");
        if (node.expanded === true) state.push("expanded");
        if (node.expanded === false) state.push("collapsed");
        if (node.selected) state.push("selected");
        if (node.pressed === true) state.push("pressed");
        if (node.focused) state.push("focused");

        const el: A11yElement = {
          id: nextId++,
          role,
          name: name || `(unnamed ${role})`,
          state,
          value: node.valuetext ?? node.valuestring ?? node.value ?? undefined,
        };
        elements.push(el);
      } else if (TEXT_ROLES.has(role) && name && name.length >= 3) {
        textNodes.push({ role, name: name.slice(0, 120) });
      }

      if (node.children) {
        for (const child of node.children) walk(child);
      }
    };

    if (snapshot) walk(snapshot);
    for (const iframeSnap of iframeSnapshots) walk(iframeSnap);

    if (elements.length > 0 || textNodes.length > 0) {
      const roleCounts: Record<string, number> = {};
      for (const el of elements) roleCounts[el.role] = (roleCounts[el.role] ?? 0) + 1;
      for (const tn of textNodes) roleCounts[tn.role] = (roleCounts[tn.role] ?? 0) + 1;
      logger.info({
        interactiveElements: elements.length,
        textNodes: textNodes.length,
        roles: roleCounts,
        sample: elements.slice(0, 5).map(e => `[${e.id}] ${e.role} "${e.name.slice(0, 25)}"`),
      }, "A11y tree extracted");
    } else {
      logger.warn("A11y tree extracted but found 0 interactive elements");
    }

    await resolveBoundingBoxes(page, elements);

    const withBbox = elements.filter(e => e.bbox).length;
    if (elements.length > 0) {
      logger.debug({ total: elements.length, withBbox, withoutBbox: elements.length - withBbox }, "Bounding boxes resolved");
    }

    const result = { elements, textNodes, tree: snapshot.children ?? [] };
    // Cache result keyed by domHash
    if (domHash) {
      if (a11yCache.size >= A11Y_CACHE_MAX) {
        const oldest = a11yCache.keys().next().value;
        if (oldest !== undefined) a11yCache.delete(oldest);
      }
      a11yCache.set(domHash, result);
    }
    return result;
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "A11y tree extraction failed \u2014 will fall back to DOM");
    return { elements, textNodes, tree: [] };
  }
}

async function resolveBoundingBoxes(page: Page, elements: A11yElement[]): Promise<void> {
  for (const el of elements) {
    try {
      const locator = await resolveElement(page, el);
      if (locator) {
        const box = await locator.boundingBox({ timeout: 1000 });
        if (box) el.bbox = box;
      }
    } catch {
      // Best-effort
    }
  }
}

// ─── Prompt Injection Sanitization ────────────────────────────────────────────

/**
 * Patterns that could hijack the LLM agent if present in page content.
 * Strips instruction-like patterns from page text before including in prompts.
 */
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
  /\b(system|assistant|admin)\s*:\s*/gi,
  /```(system|prompt|instruction)/gi,
  /<\/?(?:system|prompt|instruction|role|context)>/gi,
  /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|new\s+instructions?)\b/gi,
  /<\/?(?:human|user|claude|gpt|ai|bot)>/gi,
  /\[(?:INST|SYS|SYSTEM)\]/gi,
];

/** Sanitize text extracted from pages before including in LLM prompts. */
export function sanitizeForPrompt(text: string): string {
  let sanitized = text;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[filtered]");
  }
  return sanitized;
}

// ─── Format for LLM ──────────────────────────────────────────────────────────

export function formatA11yForLLM(elements: A11yElement[], textNodes?: A11yTextNode[]): string {
  const sections: string[] = [];

  if (textNodes && textNodes.length > 0) {
    const textLines = textNodes.map(tn => {
      const name = sanitizeForPrompt(tn.name);
      if (tn.role === "heading") return `# ${name}`;
      if (tn.role === "status" || tn.role === "alert") return `[${tn.role}] ${name}`;
      return name;
    });
    sections.push(`Page content:\n${textLines.join("\n")}`);
  }

  if (elements.length > 0) {
    const lines = elements.map(el => {
      const parts = [`[${el.id}] ${el.role} "${sanitizeForPrompt(el.name)}"`];
      if (el.state.length > 0) parts.push(`- ${el.state.join(", ")}`);
      if (el.value) parts.push(`value="${sanitizeForPrompt(el.value)}"`);
      const hint = getInteractionHint(el);
      if (hint) parts.push(hint);
      return parts.join(" ");
    });
    sections.push(`Interactive elements:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "(no interactive elements)";
  return sections.join("\n\n");
}

function getInteractionHint(el: A11yElement): string | null {
  if (el.role === "combobox" && el.state.includes("collapsed")) {
    return "-> click to expand, type to filter, ArrowDown + Enter to select";
  }
  if (el.role === "tab") {
    return "-> click to switch panel";
  }
  if (el.role === "checkbox" || el.role === "switch") {
    return "-> click to toggle";
  }
  if (el.role === "slider") {
    return "-> drag or use ArrowLeft/ArrowRight";
  }
  return null;
}

// ─── Visible Page Text ────────────────────────────────────────────────────────

const MAX_PAGE_TEXT_CHARS = 2000;

export async function extractVisibleText(page: Page): Promise<string> {
  try {
    const text = await page.evaluate(() => {
      return (document.body?.innerText ?? "").trim();
    });
    if (!text) return "";
    const cleaned = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
    return sanitizeForPrompt(cleaned.slice(0, MAX_PAGE_TEXT_CHARS));
  } catch {
    return "";
  }
}

// ─── Sufficient A11y Check ────────────────────────────────────────────────────

export function hasSufficientA11y(elements: A11yElement[]): boolean {
  return elements.length >= 3;
}

// ─── Element Resolution to Playwright Locators ───────────────────────────────

export async function resolveElement(page: Page, element: A11yElement): Promise<Locator | null> {
  try {
    const locator = page.getByRole(element.role as any, { name: element.name });
    const count = await locator.count();

    if (count === 1) {
      logger.debug({ id: element.id, role: element.role, name: element.name, strategy: "role+name" }, "Element resolved");
      return locator.first();
    }

    if (count > 1 && element.bbox) {
      for (let i = 0; i < count; i++) {
        const box = await locator.nth(i).boundingBox({ timeout: 1000 });
        if (box && Math.abs(box.x - element.bbox.x) < 50 && Math.abs(box.y - element.bbox.y) < 50) {
          logger.debug({ id: element.id, role: element.role, name: element.name, strategy: "role+name+bbox", matchIndex: i, totalMatches: count }, "Element resolved via position disambiguation");
          return locator.nth(i);
        }
      }
      logger.debug({ id: element.id, role: element.role, name: element.name, strategy: "role+name(first)", totalMatches: count }, "Multiple matches, using first");
      return locator.first();
    }

    if (count === 0) {
      if (element.role === "textbox") {
        const byLabel = page.getByLabel(element.name);
        if (await byLabel.count() > 0) {
          logger.debug({ id: element.id, name: element.name, strategy: "getByLabel" }, "Element resolved via label fallback");
          return byLabel.first();
        }
      }
      if (element.role === "button" || element.role === "link") {
        const byText = page.getByText(element.name, { exact: false });
        if (await byText.count() > 0) {
          logger.debug({ id: element.id, name: element.name, strategy: "getByText" }, "Element resolved via text fallback");
          return byText.first();
        }
      }
      // Search inside iframes as a last resort
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const frameLoc = frame.getByRole(element.role as any, { name: element.name });
          if (await frameLoc.count() > 0) {
            logger.debug({ id: element.id, role: element.role, name: element.name, strategy: "iframe-role" }, "Element resolved in iframe");
            return frameLoc.first();
          }
        } catch { /* skip inaccessible frames */ }
      }
      logger.debug({ id: element.id, role: element.role, name: element.name }, "Element NOT found \u2014 no locator matched");
    }

    return count > 0 ? locator.first() : null;
  } catch (err) {
    logger.debug({ id: element.id, role: element.role, name: element.name, err: String(err).slice(0, 100) }, "Element resolution threw");
    return null;
  }
}

// ─── Screenshot Overlay: Numbered Markers ─────────────────────────────────────

const MARKER_CONTAINER_ID = "kery-a11y-markers";

export async function injectElementMarkers(page: Page, elements: A11yElement[]): Promise<void> {
  const withBbox = elements.filter(el => el.bbox);
  if (withBbox.length === 0) return;

  try {
    await page.evaluate((items: Array<{ id: number; bbox: { x: number; y: number; width: number; height: number } }>) => {
      const existing = document.getElementById("kery-a11y-markers");
      if (existing) existing.remove();

      const container = document.createElement("div");
      container.id = "kery-a11y-markers";
      container.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:999998;pointer-events:none;";

      for (const item of items) {
        const { id, bbox } = item;
        const marker = document.createElement("div");
        marker.style.cssText =
          `position:fixed;left:${bbox.x - 8}px;top:${bbox.y - 8}px;width:16px;height:16px;` +
          `border-radius:50%;background:rgba(34,197,94,0.9);color:#fff;` +
          `font:bold 10px/16px monospace;text-align:center;z-index:999999;pointer-events:none;`;
        marker.textContent = String(id);
        container.appendChild(marker);

        const outline = document.createElement("div");
        outline.style.cssText =
          `position:fixed;left:${bbox.x}px;top:${bbox.y}px;width:${bbox.width}px;height:${bbox.height}px;` +
          `border:1.5px solid rgba(34,197,94,0.5);pointer-events:none;z-index:999998;box-sizing:border-box;`;
        container.appendChild(outline);
      }

      document.body.appendChild(container);
    }, withBbox.map(el => ({ id: el.id, bbox: el.bbox! })));
  } catch {
    // Best-effort
  }
}

export async function removeElementMarkers(page: Page): Promise<void> {
  try {
    await page.evaluate((id: string) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, MARKER_CONTAINER_ID);
  } catch {}
}
