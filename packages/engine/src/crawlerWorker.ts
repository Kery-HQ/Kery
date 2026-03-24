/**
 * App-level crawl discovery + progressive app tree builder.
 *
 * BFS link traversal with route normalization, interaction-driven pass,
 * LLM clustering for suggested test flows, and app tree construction.
 *
 * Refactored for OSS: accepts StorageAdapter instead of direct Supabase calls.
 */
import type { Page, Browser } from "playwright";
import { chromium } from "playwright";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { handleAuth, waitForPageStable } from "./agent.js";
import type { AuthConfig, AppTreeForm, AppTreeButton, AppTreeInteraction, AppTreeFormField } from "./types.js";
import { llmChat, calcCostUsd, MAX_OUTPUT_TOKENS } from "./llmClient.js";
import type { StorageAdapter } from "./storage.js";
import { rewriteForDocker } from "./dockerHost.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CRAWL_DELAY_MS = 800;
const MAX_PAGES = 80;
const MAX_DEPTH = 4;
const MAX_INTERACTIONS_PER_PAGE = 8;
const INTERACTION_SETTLE_MS = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type CrawlPageData = {
  url: string;
  route: string;
  title: string;
  depth: number;
  forms: AppTreeForm[];
  buttons: AppTreeButton[];
  interactions: AppTreeInteraction[];
  navLinks: string[];
};

export type CrawlSuggestedFlow = {
  name: string;
  intent: string;
  discoveredRoute: string;
  interactionLabel?: string;
};

export type CrawlResult = {
  status: "completed" | "failed";
  pagesVisited: number;
  nodesFound: number;
  destinationsBuilt: number;
  sitemap: CrawlPageData[];
  suggestedFlows: CrawlSuggestedFlow[];
  costUsd: number;
  error?: string;
};

// ─── Route normalization ──────────────────────────────────────────────────────

function normalizeRoute(url: string, baseOrigin: string): string {
  try {
    const u = new URL(url);
    if (u.origin !== baseOrigin) return "";
    let path = u.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
      .replace(/\/\d+/g, "/:id")
      .replace(/\/20\d{2}\/\d{2}/g, "/:date")
      .replace(/\/+$/, "") || "/";
    if (u.hash.startsWith("#/")) {
      path += u.hash.replace(/\/\d+/g, "/:id").replace(/\/[0-9a-f-]{36}/gi, "/:uuid");
    }
    return path;
  } catch {
    return "";
  }
}

function isAssetUrl(url: string): boolean {
  const extensions = [".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".map", ".json"];
  const lower = url.toLowerCase();
  if (extensions.some(ext => lower.includes(ext))) return true;
  if (lower.includes("_next/") || lower.includes("static/")) return true;
  if (/\/api\/|\/graphql|\/\_next\/data\//.test(lower)) return true;
  return false;
}

// Page data extraction script - preserved from source
const PAGE_EXTRACT_SCRIPT = `(function() {
  var result = { title: document.title || '', forms: [], buttons: [], navLinks: [] };
  function vis(el) { if (getComputedStyle(el).display === 'none') return false; if (getComputedStyle(el).visibility === 'hidden') return false; return true; }
  [].forEach.call(document.querySelectorAll('form, [role="form"]'), function(form) {
    if (!vis(form)) return;
    var fields = [];
    [].forEach.call(form.querySelectorAll('input:not([type=hidden]), textarea, select'), function(el) {
      var label = '';
      if (el.id) { var lbl = document.querySelector('label[for="' + el.id + '"]'); if (lbl) label = (lbl.textContent || '').trim().slice(0, 40); }
      if (!label) { var closest = el.closest('label'); if (closest) label = (closest.textContent || '').trim().slice(0, 40); }
      var field = { name: el.name || el.id || '', type: el.type || el.tagName.toLowerCase(), required: el.required || el.getAttribute('aria-required') === 'true', label: label, placeholder: el.placeholder || '' };
      if (el.tagName === 'SELECT') { field.options = [].slice.call(el.options, 0, 10).map(function(o) { return o.text; }); }
      fields.push(field);
    });
    var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    result.forms.push({ id: form.id || form.getAttribute('name') || 'form_' + result.forms.length, fields: fields, submitText: submitBtn ? (submitBtn.textContent || submitBtn.value || '').trim() : '' });
  });
  var ctaPattern = /create|add|new|edit|open|invite|configure|import|export|upload|delete|remove/i;
  [].forEach.call(document.querySelectorAll('button, [role="button"], [aria-haspopup], [data-dialog]'), function(el) {
    if (!vis(el) || el.closest('form, [role="form"]')) return;
    var t = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!t || t.length < 2 || t.length > 60) return;
    if (ctaPattern.test(t) || el.hasAttribute('aria-haspopup') || el.hasAttribute('data-dialog')) {
      var sel = '';
      if (el.getAttribute('data-testid')) sel = '[data-testid="' + el.getAttribute('data-testid') + '"]';
      else if (el.id) sel = '#' + el.id;
      else sel = 'button:has-text("' + t.slice(0, 30) + '")';
      result.buttons.push({ text: t, selector: sel });
    }
  });
  var origin = window.location.origin; var seen = {};
  function addLink(el) {
    try { var href = new URL(el.href, origin); var path = href.pathname + (href.search || '');
      if (href.origin !== origin) return; if (seen[path]) return;
      if (href.pathname.match(/\\.(js|css|png|jpg|jpeg|gif|svg|ico|pdf|woff|ttf|map)$/)) return;
      if (href.pathname.startsWith('/_next/') || href.pathname.startsWith('/static/')) return;
      if (href.pathname === window.location.pathname && !href.search) return;
      seen[path] = 1; result.navLinks.push(path); } catch {}
  }
  [].forEach.call(document.querySelectorAll('nav a[href], aside a[href], header a[href], [role="navigation"] a[href]'), addLink);
  [].forEach.call(document.querySelectorAll('a[href]'), function(el) { if (!vis(el)) return; addLink(el); });
  return JSON.stringify(result);
})()`;

async function extractPageData(page: Page, url: string, depth: number, baseOrigin: string): Promise<CrawlPageData> {
  const route = normalizeRoute(url, baseOrigin);
  try {
    const raw = await page.evaluate(PAGE_EXTRACT_SCRIPT) as string;
    const data = JSON.parse(raw);
    return {
      url, route, title: data.title || "", depth,
      forms: data.forms || [], buttons: data.buttons || [],
      interactions: [] as AppTreeInteraction[],
      navLinks: (data.navLinks || []).filter((l: string) => l),
    };
  } catch {
    return { url, route, title: "", depth, forms: [], buttons: [], interactions: [], navLinks: [] };
  }
}

async function discoverInteractions(page: Page, pageData: CrawlPageData): Promise<void> {
  const ctaButtons = pageData.buttons.slice(0, MAX_INTERACTIONS_PER_PAGE);
  if (ctaButtons.length === 0) return;

  for (const btn of ctaButtons) {
    try {
      const loc = page.locator(btn.selector).first();
      if (!(await loc.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      await loc.click({ timeout: 2000 });
      await new Promise(r => setTimeout(r, INTERACTION_SETTLE_MS));
      const revealed = await page.evaluate(() => {
        const dialog = document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [data-state="open"]');
        if (!dialog) return null;
        const heading = (dialog.querySelector("h1, h2, h3, [class*='title']")?.textContent || "").trim().slice(0, 60);
        const fields: string[] = [];
        dialog.querySelectorAll("input:not([type=hidden]), textarea, select").forEach(el => {
          const inp = el as HTMLInputElement;
          const name = inp.name || inp.id || inp.placeholder || inp.type;
          if (name) fields.push(name);
        });
        let type: "modal" | "drawer" | "panel" | "unknown" = "unknown";
        const cls = dialog.className || "";
        if (/modal|dialog/i.test(cls)) type = "modal";
        else if (/drawer|slide/i.test(cls)) type = "drawer";
        else if (/panel|sidebar/i.test(cls)) type = "panel";
        else if (dialog.getAttribute("role") === "dialog") type = "modal";
        return { type, heading, fields };
      });
      if (revealed) {
        pageData.interactions.push({
          trigger: btn.text, revealed: revealed.type,
          fields: revealed.fields, heading: revealed.heading,
        });
      }
      await page.keyboard.press("Escape");
      await new Promise(r => setTimeout(r, 300));
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

// ─── BFS Crawl ────────────────────────────────────────────────────────────────

export async function runCrawl(
  page: Page,
  baseUrl: string,
  auth: AuthConfig | null,
  existingTestNames: string[] = [],
): Promise<CrawlResult> {
  let baseOrigin: string;
  try { baseOrigin = new URL(baseUrl).origin; }
  catch { return { status: "failed", pagesVisited: 0, nodesFound: 0, destinationsBuilt: 0, sitemap: [], suggestedFlows: [], costUsd: 0, error: "Invalid base URL" }; }

  const visitedPatterns = new Set<string>();
  const sitemap: CrawlPageData[] = [];
  const costAccum = { usd: 0 };

  try {
    const authed = await handleAuth(page, auth, undefined, baseUrl);
    if (authed) {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    } else {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }

    const startUrl = page.url();
    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
    if (startUrl !== baseUrl) queue.push({ url: baseUrl, depth: 1 });

    while (queue.length > 0 && sitemap.length < MAX_PAGES) {
      const { url, depth } = queue.shift()!;
      if (depth > MAX_DEPTH) continue;
      const route = normalizeRoute(url, baseOrigin);
      if (!route || visitedPatterns.has(route)) continue;
      if (isAssetUrl(url)) continue;
      visitedPatterns.add(route);

      try {
        const currentRoute = normalizeRoute(page.url(), baseOrigin);
        if (currentRoute !== route) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
          await waitForPageStable(page, 4000);
        }
        await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
        const pageData = await extractPageData(page, page.url(), depth, baseOrigin);
        if (!pageData.route) continue;
        await discoverInteractions(page, pageData);
        sitemap.push(pageData);

        for (const link of pageData.navLinks) {
          const fullUrl = link.startsWith("http") ? link : `${baseOrigin}${link}`;
          const linkRoute = normalizeRoute(fullUrl, baseOrigin);
          if (linkRoute && !visitedPatterns.has(linkRoute)) {
            queue.push({ url: fullUrl, depth: depth + 1 });
          }
        }
      } catch (err) {
        logger.warn({ err: String(err), url }, "Crawl: failed to process page");
      }
    }

    const suggestedFlows = await clusterIntoFlows(sitemap, existingTestNames, baseUrl, costAccum);

    return {
      status: "completed", pagesVisited: sitemap.length,
      nodesFound: sitemap.length + sitemap.reduce((acc, p) => acc + p.interactions.length, 0),
      destinationsBuilt: sitemap.length, sitemap, suggestedFlows, costUsd: costAccum.usd,
    };
  } catch (err) {
    return {
      status: "failed", pagesVisited: sitemap.length, nodesFound: 0, destinationsBuilt: 0,
      sitemap, suggestedFlows: [], costUsd: costAccum.usd, error: String(err),
    };
  }
}

async function clusterIntoFlows(
  sitemap: CrawlPageData[], existingTestNames: string[], baseUrl: string, costAccum: { usd: number },
): Promise<CrawlSuggestedFlow[]> {
  if (sitemap.length === 0) return [];
  const config = getConfig();
  const sitemapText = sitemap.map(p => `${p.route} ${p.forms.length > 0 ? "FORM" : ""} ${p.interactions.length > 0 ? "MODAL" : ""} \u2192 ${p.title || "(no title)"}`).join("\n");

  const prompt = `You are a QA engineer reviewing a sitemap. Suggest the most valuable test flows. Max 15 suggestions.

Existing tests (skip these): ${existingTestNames.length > 0 ? existingTestNames.join(", ") : "(none)"}

Sitemap:
${sitemapText}

Return ONLY a JSON array: [{"name":"Short name","intent":"Step-by-step instructions starting from ${baseUrl}","discoveredRoute":"/route"}]`;

  try {
    const { content: raw, usage } = await llmChat([{ role: "user", content: prompt }], config.scriptModel, { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 });
    costAccum.usd += calcCostUsd(config.scriptModel, usage.inputTokens, usage.outputTokens);
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 15).map((f: any) => ({
      name: String(f.name ?? "Flow"), intent: String(f.intent ?? ""), discoveredRoute: String(f.discoveredRoute ?? "/"),
    }));
  } catch {
    return [];
  }
}

export async function generateIntentForNode(
  route: string, title: string, forms: AppTreeForm[], buttons: AppTreeButton[], interactions: AppTreeInteraction[], baseUrl: string,
  costAccum?: { usd: number },
): Promise<string | null> {
  const config = getConfig();
  const context: string[] = [`Route: ${route}`, `Title: ${title}`];
  if (forms.length > 0) context.push(`Forms: ${forms.map(f => f.id).join("; ")}`);
  if (buttons.length > 0) context.push(`Buttons: ${buttons.map(b => b.text).join(", ")}`);

  const prompt = `Generate a single test intent for this page starting from ${baseUrl}.\n\n${context.join("\n")}\n\nReply with ONLY the intent text.`;
  try {
    const { content, usage } = await llmChat([{ role: "user", content: prompt }], config.summaryModel, { maxTokens: 16384, temperature: 0.2 });
    if (costAccum) costAccum.usd += calcCostUsd(config.summaryModel, usage.inputTokens, usage.outputTokens);
    const intent = content.trim();
    return intent.length > 20 ? intent : null;
  } catch { return null; }
}

// ─── Orchestrator (OSS: uses local Playwright only) ─────────────────────────

export async function executeCrawlRun(
  storage: StorageAdapter,
  projectId: string,
  environmentId: string,
  triggerType: "manual" | "webhook" | "scheduled",
): Promise<{ crawlRunId: string; result: CrawlResult }> {
  const env = await storage.getCrawlEnvironment(projectId, environmentId);
  if (!env) throw new Error("Environment not found");

  const authRow = await storage.getAuthConfig(projectId, environmentId);
  let auth: AuthConfig | null = null;
  if (authRow) {
    const cfg = authRow.config_json as any;
    auth = { mode: authRow.mode, ...cfg };
  }

  const existingTestNames = await storage.getExistingTestNames(projectId);

  const runRow = await storage.createCrawlRun({
    project_id: projectId, environment_id: environmentId, status: "running", trigger_type: triggerType,
  });
  const crawlRunId = runRow.id;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setDefaultTimeout(10000);

    const result = await runCrawl(page, rewriteForDocker(env.base_url), auth, existingTestNames);

    const treeDiff = await storage.buildAppTree(projectId, crawlRunId, result.sitemap);
    result.destinationsBuilt = treeDiff.added ?? result.destinationsBuilt;

    await storage.updateCrawlRun(crawlRunId, {
      status: result.status, pages_visited: result.pagesVisited,
      nodes_found: result.nodesFound, destinations_built: result.destinationsBuilt,
      sitemap_json: result.sitemap, cost_usd: result.costUsd,
      completed_at: new Date().toISOString(),
    });

    await browser.close();
    return { crawlRunId, result };
  } catch (err) {
    await storage.updateCrawlRun(crawlRunId, { status: "failed", completed_at: new Date().toISOString() });
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}
