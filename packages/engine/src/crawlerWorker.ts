/**
 * App-level crawl discovery + progressive app tree builder.
 *
 * BFS link traversal with route normalization, interaction-driven pass,
 * rule-based + batched LLM link filtering (content/noise), LLM clustering
 * for suggested test flows, and app tree construction.
 *
 * Refactored for OSS: accepts StorageAdapter instead of direct Supabase calls.
 */
import type { Page, Browser } from "playwright";
import { chromium } from "playwright";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { handleAuth, waitForPageStable, type LLMCallRecord, type LLMStoredMessage } from "./agent.js";
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
/** Max links per LLM call; larger lists are split into sequential batches so every candidate is classified. */
const LINK_FILTER_LLM_BATCH_SIZE = 40;

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

/** LLM spend during crawl: batched link filtering + suggested-flow clustering. */
export type CrawlLlmCostBreakdown = {
  linkFilterUsd: number;
  suggestedFlowsUsd: number;
};

/** Persisted for crawl analysis UI (timing, limits, counts). */
export type CrawlMetadata = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limits: {
    maxPages: number;
    maxDepth: number;
    crawlDelayMs: number;
    linkFilterBatchSize: number;
    maxInteractionsPerPage: number;
  };
  stats: {
    pagesVisited: number;
    nodesFound: number;
    suggestedFlowsCount: number;
    llmCallCount: number;
  };
};

export type CrawlResult = {
  status: "completed" | "failed";
  pagesVisited: number;
  nodesFound: number;
  destinationsBuilt: number;
  sitemap: CrawlPageData[];
  suggestedFlows: CrawlSuggestedFlow[];
  /** Total LLM cost (USD); equals linkFilterUsd + suggestedFlowsUsd when only those stages run. */
  costUsd: number;
  llmCostBreakdown: CrawlLlmCostBreakdown;
  /** Full LLM audit (same shape as test runs; agent crawl_link_filter | crawl_suggested_flows). */
  llmCalls: LLMCallRecord[];
  crawlMetadata: CrawlMetadata;
  error?: string;
};

type CrawlCostAccum = {
  usd: number;
  linkFilterUsd: number;
  suggestedFlowsUsd: number;
};

function emptyBreakdown(): CrawlLlmCostBreakdown {
  return { linkFilterUsd: 0, suggestedFlowsUsd: 0 };
}

function breakdownFromAccum(acc: CrawlCostAccum): CrawlLlmCostBreakdown {
  return { linkFilterUsd: acc.linkFilterUsd, suggestedFlowsUsd: acc.suggestedFlowsUsd };
}

function crawlMetadataLimits(): CrawlMetadata["limits"] {
  return {
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    crawlDelayMs: CRAWL_DELAY_MS,
    linkFilterBatchSize: LINK_FILTER_LLM_BATCH_SIZE,
    maxInteractionsPerPage: MAX_INTERACTIONS_PER_PAGE,
  };
}

/** Phase label for live crawl progress (persisted in crawl_metadata_json while status is running). */
export type CrawlProgressPhase = "crawling" | "suggested_flows";

/** Partial metadata written during a run so the UI can show progress after refresh. */
export type CrawlProgressMetadata = {
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  phase: CrawlProgressPhase;
  limits: CrawlMetadata["limits"];
  stats: {
    pagesVisited: number;
    nodesFound: number;
    suggestedFlowsCount: number;
    llmCallCount: number;
  };
  live?: {
    queueDepth: number;
    currentUrl: string | null;
    currentRoute: string | null;
  };
  inProgress: true;
};

export type CrawlProgressSnapshot = {
  phase: CrawlProgressPhase;
  sitemap: CrawlPageData[];
  pagesVisited: number;
  nodesFound: number;
  queueDepth: number;
  currentUrl: string | null;
  currentRoute: string | null;
  costUsd: number;
  llmCostBreakdown: CrawlLlmCostBreakdown;
  llmCalls: LLMCallRecord[];
  crawlMetadataPartial: CrawlProgressMetadata;
};

export type RunCrawlOptions = {
  onProgress?: (snapshot: CrawlProgressSnapshot) => void | Promise<void>;
};

function countNodesFound(sitemap: CrawlPageData[]): number {
  return sitemap.length + sitemap.reduce((a, p) => a + p.interactions.length, 0);
}

function buildProgressMetadata(
  baseUrl: string,
  startedAtMs: number,
  sitemap: CrawlPageData[],
  llmCalls: LLMCallRecord[],
  phase: CrawlProgressPhase,
  live: { queueDepth: number; currentUrl: string | null; currentRoute: string | null },
): CrawlProgressMetadata {
  const now = Date.now();
  return {
    baseUrl,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: now - startedAtMs,
    phase,
    limits: crawlMetadataLimits(),
    stats: {
      pagesVisited: sitemap.length,
      nodesFound: countNodesFound(sitemap),
      suggestedFlowsCount: 0,
      llmCallCount: llmCalls.length,
    },
    live,
    inProgress: true,
  };
}

function buildCrawlMetadata(
  baseUrl: string,
  startedAtMs: number,
  sitemap: CrawlPageData[],
  suggestedFlows: CrawlSuggestedFlow[],
  llmCalls: LLMCallRecord[],
): CrawlMetadata {
  const finishedAt = Date.now();
  return {
    baseUrl,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAtMs,
    limits: crawlMetadataLimits(),
    stats: {
      pagesVisited: sitemap.length,
      nodesFound: countNodesFound(sitemap),
      suggestedFlowsCount: suggestedFlows.length,
      llmCallCount: llmCalls.length,
    },
  };
}

function recordCrawlLlmCall(
  calls: LLMCallRecord[],
  seqRef: { current: number },
  args: {
    agent: "crawl_link_filter" | "crawl_suggested_flows";
    model: string;
    query: string;
    requestMessages: LLMStoredMessage[];
    response: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    durationMs: number;
    costUsd: number;
    stepIndex?: number;
    crawlContext?: Record<string, unknown>;
  },
): void {
  seqRef.current += 1;
  calls.push({
    seq: seqRef.current,
    stepIndex: args.stepIndex ?? 0,
    model: args.model,
    hasVision: false,
    attempt: 1,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    totalTokens: args.usage.totalTokens,
    durationMs: args.durationMs,
    costUsd: args.costUsd,
    query: args.query,
    requestMessages: args.requestMessages,
    response: args.response,
    agent: args.agent,
    crawlContext: args.crawlContext,
  });
}

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

/** Check if a URL is a login/auth page that should be skipped during crawling. */
function isLoginPage(url: string, loginUrl: string): boolean {
  try {
    const u = new URL(url);
    const login = new URL(loginUrl);
    // Exact path match
    if (u.origin === login.origin && u.pathname === login.pathname) return true;
    // Common login path patterns
    const loginPatterns = ["/login", "/signin", "/sign-in", "/auth", "/authenticate", "/sso"];
    const lowerPath = u.pathname.toLowerCase();
    return loginPatterns.some(p => lowerPath === p || lowerPath.startsWith(p + "/"));
  } catch {
    return false;
  }
}

function isAssetUrl(url: string): boolean {
  const extensions = [".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map", ".json", ".pdf", ".zip", ".mp4", ".webm"];
  const lower = url.toLowerCase();
  if (extensions.some(ext => lower.includes(ext))) return true;
  if (lower.includes("_next/") || lower.includes("static/")) return true;
  if (/\/api\/|\/graphql|\/\_next\/data\//.test(lower)) return true;
  return false;
}

/**
 * First-pass deterministic filter: obvious non-app / non-QA targets before LLM.
 * Does not try to be complete — remaining links go to batched LLM verification.
 */
function ruleBasedRejectLink(url: string, baseOrigin: string, auth: AuthConfig | null): boolean {
  if (isAssetUrl(url)) return true;
  if (auth?.loginUrl && isLoginPage(url, auth.loginUrl)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.origin !== baseOrigin) return true;

  const pathLower = u.pathname.toLowerCase();
  const pathWithQuery = pathLower + u.search.toLowerCase();

  const noiseFragments = [
    "/tag/", "/tags/", "/category/", "/categories/", "/author/", "/authors/",
    "/feed", "/rss", "/atom", "/wp-admin", "/wp-includes", "/wp-content/plugins",
    "/sitemap", ".xml",
    "/cdn-cgi/", "/.well-known/",
  ];
  if (noiseFragments.some(f => pathWithQuery.includes(f))) return true;

  const legalPaths = ["/privacy", "/terms", "/legal", "/cookies", "/gdpr", "/ccpa", "/security", "/imprint", "/disclaimer"];
  for (const p of legalPaths) {
    if (pathLower === p || pathLower === `${p}/` || pathLower.startsWith(`${p}/`)) return true;
  }

  if (/\/page\/\d+\/?$/.test(pathLower)) return true;

  const authNoise = ["/signup", "/sign-up", "/register", "/reset-password", "/forgot-password", "/verify-email"];
  if (authNoise.some(p => pathLower === p || pathLower.startsWith(p + "/"))) return true;

  if (pathWithQuery.includes("/search") && (pathWithQuery.includes("q=") || pathWithQuery.includes("query=") || pathWithQuery.includes("s="))) return true;

  return false;
}

function toFullUrl(pathOrUrl: string, baseOrigin: string): string {
  return pathOrUrl.startsWith("http") ? pathOrUrl : `${baseOrigin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/**
 * Rule-based filter, then batched LLM: each batch is one call; all batches run so no candidate is skipped.
 * On LLM parse failure, keeps the whole batch (fail-open) so we do not drop unclassified links.
 */
async function filterNavLinksForQueue(
  navLinks: string[],
  baseOrigin: string,
  baseUrl: string,
  pageRoute: string,
  pageTitle: string,
  auth: AuthConfig | null,
  costAccum: CrawlCostAccum,
  llmCalls: LLMCallRecord[],
  seqRef: { current: number },
): Promise<string[]> {
  const fullUrls = [...new Set(navLinks.map(l => toFullUrl(l, baseOrigin)))];
  const afterRules = fullUrls.filter(u => !ruleBasedRejectLink(u, baseOrigin, auth));
  if (afterRules.length === 0) return [];

  const totalBatches = Math.max(1, Math.ceil(afterRules.length / LINK_FILTER_LLM_BATCH_SIZE));
  const kept: string[] = [];
  let batchIndex = 0;
  for (let i = 0; i < afterRules.length; i += LINK_FILTER_LLM_BATCH_SIZE) {
    batchIndex += 1;
    const batch = afterRules.slice(i, i + LINK_FILTER_LLM_BATCH_SIZE);
    const batchKept = await llmVerifyLinksKeep(
      batch,
      { pageRoute, pageTitle, baseUrl, baseOrigin },
      costAccum,
      llmCalls,
      seqRef,
      { batchIndex, totalBatches },
    );
    kept.push(...batchKept);
  }
  return kept;
}

async function llmVerifyLinksKeep(
  batch: string[],
  ctx: { pageRoute: string; pageTitle: string; baseUrl: string; baseOrigin: string },
  costAccum: CrawlCostAccum,
  llmCalls: LLMCallRecord[],
  seqRef: { current: number },
  batchMeta: { batchIndex: number; totalBatches: number },
): Promise<string[]> {
  if (batch.length === 0) return [];
  const config = getConfig();
  const lines = batch.map((u, i) => `${i + 1}. ${u}`).join("\n");
  const prompt = `You filter crawl queue candidates for automated QA of a web application (discovering UI, forms, workflows, dashboards — not indexing blog/content).

Context — page being crawled: route=${ctx.pageRoute}
Page title: ${JSON.stringify(ctx.pageTitle)}
Site base: ${ctx.baseUrl}

For each URL below (same-origin), decide whether crawling it is likely useful for **functional/product QA**. REJECT (do not include in keep): individual blog posts, news articles, help doc pages, tag/category/author archives, feeds, legal/marketing-only pages, and similar content-driven URLs when the site also has an app. KEEP: app areas, settings, dashboards, onboarding, feature pages with interactive UI.

Return ONLY valid JSON, no markdown: {"keep":["url1","url2"]}
The strings in "keep" MUST be copied exactly from the list below (full URL after the number.).

${lines}`;

  const tryParse = (raw: string): string[] | null => {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(stripped.slice(start, end + 1)) as { keep?: unknown };
      if (!Array.isArray(parsed.keep)) return null;
      return parsed.keep.filter((x): x is string => typeof x === "string");
    } catch {
      return null;
    }
  };

  const requestMessages: LLMStoredMessage[] = [{ role: "user", content: prompt }];
  const querySummary = `link-filter batch ${batchMeta.batchIndex}/${batchMeta.totalBatches} @ ${ctx.pageRoute} (${batch.length} URLs)`;

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(
      [{ role: "user", content: prompt }],
      config.scriptModel,
      { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.1 },
    );
    const durationMs = Date.now() - t0;
    const delta = calcCostUsd(config.scriptModel, usage.inputTokens, usage.outputTokens, "scriptModel");
    costAccum.usd += delta;
    costAccum.linkFilterUsd += delta;
    const fromModel = tryParse(raw);
    const batchSet = new Set(batch);
    let outcome: "ok" | "parse_failed" | "url_mismatch";
    let resultUrls: string[];
    if (fromModel == null) {
      logger.warn({ batchSize: batch.length }, "Crawl: link-filter LLM parse failed, keeping batch");
      outcome = "parse_failed";
      resultUrls = [...batch];
    } else {
      const filtered = fromModel.filter(u => batchSet.has(u));
      if (filtered.length === 0 && fromModel.length > 0) {
        logger.warn({ batchSize: batch.length }, "Crawl: link-filter LLM returned no exact URL matches, keeping batch");
        outcome = "url_mismatch";
        resultUrls = [...batch];
      } else {
        outcome = "ok";
        resultUrls = filtered;
      }
    }

    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_link_filter",
      model: config.scriptModel,
      query: querySummary,
      requestMessages,
      response: raw ?? "",
      usage: usage,
      durationMs,
      costUsd: delta,
      stepIndex: batchMeta.batchIndex,
      crawlContext: {
        phase: "link_filter",
        sourcePageRoute: ctx.pageRoute,
        batchIndex: batchMeta.batchIndex,
        totalBatches: batchMeta.totalBatches,
        batchSize: batch.length,
        outcome,
        keptCount: resultUrls.length,
      },
    });
    return resultUrls;
  } catch (err) {
    const msg = String(err);
    logger.warn({ err: msg, batchSize: batch.length }, "Crawl: link-filter LLM failed, keeping batch");
    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_link_filter",
      model: config.scriptModel,
      query: querySummary,
      requestMessages,
      response: `ERROR: ${msg}`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      costUsd: 0,
      stepIndex: batchMeta.batchIndex,
      crawlContext: {
        phase: "link_filter",
        sourcePageRoute: ctx.pageRoute,
        batchIndex: batchMeta.batchIndex,
        totalBatches: batchMeta.totalBatches,
        batchSize: batch.length,
        outcome: "error",
        error: msg,
      },
    });
    return [...batch];
  }
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
  options: RunCrawlOptions = {},
): Promise<CrawlResult> {
  const crawlStartedAt = Date.now();
  const llmCalls: LLMCallRecord[] = [];
  const seqRef = { current: 0 };

  let baseOrigin: string;
  try { baseOrigin = new URL(baseUrl).origin; }
  catch {
    return {
      status: "failed", pagesVisited: 0, nodesFound: 0, destinationsBuilt: 0,
      sitemap: [], suggestedFlows: [], costUsd: 0, llmCostBreakdown: emptyBreakdown(),
      llmCalls: [],
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, [], [], []),
      error: "Invalid base URL",
    };
  }

  const visitedPatterns = new Set<string>();
  const sitemap: CrawlPageData[] = [];
  const costAccum: CrawlCostAccum = { usd: 0, linkFilterUsd: 0, suggestedFlowsUsd: 0 };

  async function emitProgress(
    phase: CrawlProgressPhase,
    live: { queueDepth: number; currentUrl: string | null; currentRoute: string | null },
  ): Promise<void> {
    const onProgress = options.onProgress;
    if (!onProgress) return;
    const nodesFound = countNodesFound(sitemap);
    const snap: CrawlProgressSnapshot = {
      phase,
      sitemap: [...sitemap],
      pagesVisited: sitemap.length,
      nodesFound,
      queueDepth: live.queueDepth,
      currentUrl: live.currentUrl,
      currentRoute: live.currentRoute,
      costUsd: costAccum.usd,
      llmCostBreakdown: breakdownFromAccum(costAccum),
      llmCalls: [...llmCalls],
      crawlMetadataPartial: buildProgressMetadata(
        baseUrl, crawlStartedAt, sitemap, llmCalls, phase, live,
      ),
    };
    await onProgress(snap);
  }

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

        // Skip pages that look like login forms (content-based detection)
        // Also re-authenticate if an auth-expired redirect landed us on a login page
        {
          const hasPasswordField = pageData.forms.some((f: any) =>
            f.fields?.some((fd: any) => fd.type === "password")
          );
          const titleLooksLogin = /log\s*in|sign\s*in|authenticate/i.test(pageData.title);
          const urlLooksLogin = auth?.loginUrl ? isLoginPage(page.url(), auth.loginUrl) : false;
          const looksLikeLogin = hasPasswordField || (titleLooksLogin && urlLooksLogin);
          if (looksLikeLogin) {
            // If we have auth config, this might be an expired session — try re-authenticating
            if (auth) {
              logger.info({ url: page.url() }, "Crawl: login page detected mid-crawl, re-authenticating");
              try {
                const { handleAuth } = await import("./agent.js");
                await handleAuth(page, auth, undefined, baseUrl);
                // Retry navigating to the original URL after re-auth
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
                await waitForPageStable(page, 4000);
              } catch (authErr) {
                logger.warn({ err: String(authErr).slice(0, 200) }, "Crawl: re-auth failed, skipping login page");
                continue;
              }
            } else {
              logger.debug({ url: page.url(), title: pageData.title }, "Crawl: skipping login page");
              continue;
            }
          }
        }
        await discoverInteractions(page, pageData);
        sitemap.push(pageData);
        logger.info(
          { route: pageData.route, pagesSoFar: sitemap.length, queueDepth: queue.length },
          "Crawl: page visited",
        );

        const filteredLinks = await filterNavLinksForQueue(
          pageData.navLinks,
          baseOrigin,
          baseUrl,
          pageData.route,
          pageData.title,
          auth,
          costAccum,
          llmCalls,
          seqRef,
        );

        for (const fullUrl of filteredLinks) {
          const linkRoute = normalizeRoute(fullUrl, baseOrigin);
          if (linkRoute && !visitedPatterns.has(linkRoute)) {
            if (auth?.loginUrl && isLoginPage(fullUrl, auth.loginUrl)) {
              logger.debug({ url: fullUrl, loginUrl: auth.loginUrl }, "Crawl: skipping login page URL");
              continue;
            }
            queue.push({ url: fullUrl, depth: depth + 1 });
          }
        }

        await emitProgress("crawling", {
          queueDepth: queue.length,
          currentUrl: page.url(),
          currentRoute: pageData.route,
        });
      } catch (err) {
        logger.warn({ err: String(err), url }, "Crawl: failed to process page");
      }
    }

    await emitProgress("suggested_flows", {
      queueDepth: queue.length,
      currentUrl: null,
      currentRoute: null,
    });

    const suggestedFlows = await clusterIntoFlows(
      sitemap, existingTestNames, baseUrl, costAccum, llmCalls, seqRef,
    );

    return {
      status: "completed", pagesVisited: sitemap.length,
      nodesFound: sitemap.length + sitemap.reduce((acc, p) => acc + p.interactions.length, 0),
      destinationsBuilt: sitemap.length, sitemap, suggestedFlows,
      costUsd: costAccum.usd, llmCostBreakdown: breakdownFromAccum(costAccum),
      llmCalls,
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, sitemap, suggestedFlows, llmCalls),
    };
  } catch (err) {
    return {
      status: "failed", pagesVisited: sitemap.length, nodesFound: 0, destinationsBuilt: 0,
      sitemap, suggestedFlows: [], costUsd: costAccum.usd, llmCostBreakdown: breakdownFromAccum(costAccum),
      llmCalls,
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, sitemap, [], llmCalls),
      error: String(err),
    };
  }
}

async function clusterIntoFlows(
  sitemap: CrawlPageData[],
  existingTestNames: string[],
  baseUrl: string,
  costAccum: CrawlCostAccum,
  llmCalls: LLMCallRecord[],
  seqRef: { current: number },
): Promise<CrawlSuggestedFlow[]> {
  if (sitemap.length === 0) return [];
  const config = getConfig();
  const sitemapText = sitemap.map(p => `${p.route} ${p.forms.length > 0 ? "FORM" : ""} ${p.interactions.length > 0 ? "MODAL" : ""} \u2192 ${p.title || "(no title)"}`).join("\n");

  const prompt = `You are a QA engineer reviewing a sitemap. Suggest the most valuable test flows. Max 15 suggestions.

Existing tests (skip these): ${existingTestNames.length > 0 ? existingTestNames.join(", ") : "(none)"}

Sitemap:
${sitemapText}

Return ONLY a JSON array: [{"name":"Short name","intent":"Step-by-step instructions starting from ${baseUrl}","discoveredRoute":"/route"}]`;

  const requestMessages: LLMStoredMessage[] = [{ role: "user", content: prompt }];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(
      [{ role: "user", content: prompt }],
      config.scriptModel,
      { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 },
    );
    const durationMs = Date.now() - t0;
    const delta = calcCostUsd(config.scriptModel, usage.inputTokens, usage.outputTokens, "scriptModel");
    costAccum.usd += delta;
    costAccum.suggestedFlowsUsd += delta;

    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_suggested_flows",
      model: config.scriptModel,
      query: `suggested flows (${sitemap.length} pages in sitemap)`,
      requestMessages,
      response: raw ?? "",
      usage,
      durationMs,
      costUsd: delta,
      stepIndex: 0,
      crawlContext: {
        phase: "suggested_flows",
        sitemapPageCount: sitemap.length,
        existingTestNamesCount: existingTestNames.length,
      },
    });

    const stripped = (raw ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 15).map((f: any) => ({
      name: String(f.name ?? "Flow"), intent: String(f.intent ?? ""), discoveredRoute: String(f.discoveredRoute ?? "/"),
    }));
  } catch (err) {
    const msg = String(err);
    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_suggested_flows",
      model: config.scriptModel,
      query: `suggested flows (${sitemap.length} pages in sitemap)`,
      requestMessages,
      response: `ERROR: ${msg}`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      costUsd: 0,
      stepIndex: 0,
      crawlContext: { phase: "suggested_flows", outcome: "error", error: msg },
    });
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
    const { content, usage } = await llmChat([{ role: "user", content: prompt }], config.summaryModel, { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 });
    if (costAccum) costAccum.usd += calcCostUsd(config.summaryModel, usage.inputTokens, usage.outputTokens, "summaryModel");
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

  const lastSnapshotRef = { current: null as CrawlProgressSnapshot | null };
  const persistProgress = async (snap: CrawlProgressSnapshot) => {
    lastSnapshotRef.current = snap;
    await storage.updateCrawlRun(crawlRunId, {
      pages_visited: snap.pagesVisited,
      nodes_found: snap.nodesFound,
      sitemap_json: snap.sitemap,
      cost_usd: snap.costUsd,
      llm_cost_breakdown_json: snap.llmCostBreakdown,
      llm_calls_json: snap.llmCalls,
      crawl_metadata_json: snap.crawlMetadataPartial,
    });
  };

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setDefaultTimeout(10000);

    const result = await runCrawl(page, rewriteForDocker(env.base_url), auth, existingTestNames, {
      onProgress: persistProgress,
    });

    const treeDiff = await storage.buildAppTree(projectId, crawlRunId, result.sitemap);
    result.destinationsBuilt = treeDiff.added ?? result.destinationsBuilt;

    await storage.updateCrawlRun(crawlRunId, {
      status: result.status, pages_visited: result.pagesVisited,
      nodes_found: result.nodesFound, destinations_built: result.destinationsBuilt,
      sitemap_json: result.sitemap, cost_usd: result.costUsd,
      llm_cost_breakdown_json: result.llmCostBreakdown,
      llm_calls_json: result.llmCalls,
      crawl_metadata_json: result.crawlMetadata,
      completed_at: new Date().toISOString(),
    });

    await browser.close();
    return { crawlRunId, result };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const lastSnapshot = lastSnapshotRef.current;
    if (lastSnapshot) {
      await storage.updateCrawlRun(crawlRunId, {
        status: "failed",
        completed_at: completedAt,
        pages_visited: lastSnapshot.pagesVisited,
        nodes_found: lastSnapshot.nodesFound,
        sitemap_json: lastSnapshot.sitemap,
        cost_usd: lastSnapshot.costUsd,
        llm_cost_breakdown_json: lastSnapshot.llmCostBreakdown,
        llm_calls_json: lastSnapshot.llmCalls,
        crawl_metadata_json: {
          ...lastSnapshot.crawlMetadataPartial,
          inProgress: false,
        },
      }).catch(() => {});
    } else {
      await storage.updateCrawlRun(crawlRunId, { status: "failed", completed_at: completedAt }).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}
