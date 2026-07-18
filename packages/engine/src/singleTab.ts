/**
 * Single-tab enforcement.
 *
 * The Navigator drives exactly one Page reference for an entire run; a click
 * that opens a new tab (target="_blank" or window.open) navigates a page the
 * agent never observes. The agent then sees an unchanged DOM, trips the
 * stagnation detector, and files a false "control does nothing" bug.
 *
 * Fix: an init script rewrites new-tab navigations to happen in the current
 * tab and records each intercept in sessionStorage. A context-level "page"
 * listener catches anything that still slips through (e.g. form[target],
 * cross-origin iframe popups), closes the stray page, and records its URL.
 * The agent loop drains these records each snapshot via consumeNewTabNote()
 * so the LLM is told why the URL changed (or why a popup was closed).
 */
import type { BrowserContext, Page } from "playwright";
import { logger } from "./logger.js";

const STORAGE_KEY = "__kery_newtab_intercepts";

const popupNotesByContext = new WeakMap<BrowserContext, string[]>();
const enforcedContexts = new WeakSet<BrowserContext>();

const INIT_SCRIPT = `(() => {
  if (window.__keryNewTabGuard) return;
  window.__keryNewTabGuard = true;
  const record = (url) => {
    try {
      const raw = sessionStorage.getItem(${JSON.stringify(STORAGE_KEY)});
      const list = raw ? JSON.parse(raw) : [];
      list.push(String(url || ""));
      sessionStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(list.slice(-10)));
    } catch {}
  };
  const origOpen = window.open;
  window.open = function (url, target, features) {
    record(url);
    if (url) {
      try {
        location.href = String(url);
        return null;
      } catch {}
    }
    return origOpen ? origOpen.call(window, url, "_self", features) : null;
  };
  document.addEventListener("click", (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const node of path) {
      if (node && node.tagName === "A" && /^(_blank|_new)$/i.test(node.getAttribute("target") || "")) {
        node.removeAttribute("target");
        record(node.href);
        break;
      }
    }
  }, true);
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form && form.tagName === "FORM" && /^(_blank|_new)$/i.test(form.getAttribute("target") || "")) {
      form.removeAttribute("target");
      record(form.action || "");
    }
  }, true);
})();`;

/**
 * Install same-tab enforcement on the page's context. Idempotent per context.
 */
export async function enforceSingleTab(page: Page): Promise<void> {
  const context = page.context();
  if (enforcedContexts.has(context)) return;
  enforcedContexts.add(context);

  await context.addInitScript(INIT_SCRIPT);
  // The main page already exists, so the context init script won't run on it
  // until its next navigation; cover the current document too.
  await page.evaluate(INIT_SCRIPT).catch(() => {});

  context.on("page", (stray) => {
    void (async () => {
      try {
        await stray.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        const url = stray.url();
        await stray.close().catch(() => {});
        const notes = popupNotesByContext.get(context) ?? [];
        notes.push(url);
        popupNotesByContext.set(context, notes.slice(-10));
        logger.info({ url }, "Single-tab: closed stray popup page");
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 160) }, "Single-tab: popup cleanup failed");
      }
    })();
  });

  logger.info("Single-tab enforcement installed");
}

/**
 * Drain intercept records accumulated since the last call and format them as
 * an observation note for the LLM. Returns undefined when nothing happened.
 */
export async function consumeNewTabNote(page: Page): Promise<string | undefined> {
  const intercepted: string[] = await page
    .evaluate((key) => {
      try {
        const raw = sessionStorage.getItem(key);
        sessionStorage.removeItem(key);
        return raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        return [];
      }
    }, STORAGE_KEY)
    .catch(() => []);

  const context = page.context();
  const closedPopups = popupNotesByContext.get(context) ?? [];
  popupNotesByContext.delete(context);

  const lines: string[] = [];
  for (const url of intercepted) {
    lines.push(
      `Your last interaction tried to open a NEW TAB${url ? ` (${url})` : ""}; it was opened in the CURRENT tab instead. ` +
        `This is expected test-harness behavior, not an application bug. Use "back" to return if needed.`,
    );
  }
  for (const url of closedPopups) {
    lines.push(
      `Your last interaction opened a popup window${url && url !== "about:blank" ? ` (${url})` : ""}; it was closed automatically. ` +
        `This is expected test-harness behavior, not an application bug.${url && url !== "about:blank" ? ` Navigate to that URL directly if you need to test it.` : ""}`,
    );
  }
  if (lines.length === 0) return undefined;
  return `NEW TAB INTERCEPTED:\n${lines.map((l) => `  - ${l}`).join("\n")}`;
}
