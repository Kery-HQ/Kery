/**
 * App-level crawl discovery + progressive app tree builder.
 *
 * BFS link traversal with route normalization, interaction-driven pass,
 * rule-only queue expansion during crawl, then shallow-route cap + parallel
 * batched LLM route filtering (webapp-focused), suggested flows, app tree.
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
/** Hard cap on Playwright visits during BFS (safety). */
const MAX_CRAWL_PAGES = 500;
/** After crawl: max normalized routes kept for the app tree (shallow routes win if over cap). */
const MAX_APP_ROUTES = 80;
const MAX_DEPTH = 4;
const MAX_INTERACTIONS_PER_PAGE = 8;
const INTERACTION_SETTLE_MS = 1000;
/** Routes per parallel LLM batch in the post-crawl filter pass. */
const ROUTE_FILTER_LLM_BATCH_SIZE = 40;

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
    maxCrawlPages: number;
    maxAppRoutes: number;
    maxDepth: number;
    crawlDelayMs: number;
    routeFilterBatchSize: number;
    maxInteractionsPerPage: number;
  };
  stats: {
    pagesVisited: number;
    nodesFound: number;
    suggestedFlowsCount: number;
    llmCallCount: number;
  };
  /** Set when the crawl throws before finishing normally. */
  error?: string;
  /** Pipeline counts and user-facing hints (e.g. why 0 pages). */
  diagnostics?: {
    bfsPagesDiscovered: number;
    afterShallowTrim: number;
    afterRouteFilter: number;
    hints: string[];
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
  /** Full LLM audit (same shape as test runs; crawl_route_filter | crawl_suggested_flows). */
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
    maxCrawlPages: MAX_CRAWL_PAGES,
    maxAppRoutes: MAX_APP_ROUTES,
    maxDepth: MAX_DEPTH,
    crawlDelayMs: CRAWL_DELAY_MS,
    routeFilterBatchSize: ROUTE_FILTER_LLM_BATCH_SIZE,
    maxInteractionsPerPage: MAX_INTERACTIONS_PER_PAGE,
  };
}

/** Phase label for live crawl progress (persisted in crawl_metadata_json while status is running). */
export type CrawlProgressPhase = "crawling" | "route_filter" | "suggested_flows";

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
  extras?: { error?: string; diagnostics?: CrawlMetadata["diagnostics"] },
): CrawlMetadata {
  const finishedAt = Date.now();
  const meta: CrawlMetadata = {
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
  if (extras?.error) meta.error = extras.error;
  if (extras?.diagnostics) meta.diagnostics = extras.diagnostics;
  return meta;
}

function minimalFailedCrawlMetadata(
  baseUrl: string,
  startedAtIso: string,
  completedAtIso: string,
  err: string,
): CrawlMetadata {
  const t0 = new Date(startedAtIso).getTime();
  const t1 = new Date(completedAtIso).getTime();
  return {
    baseUrl,
    startedAt: startedAtIso,
    finishedAt: completedAtIso,
    durationMs: Number.isFinite(t1 - t0) ? Math.max(0, t1 - t0) : 0,
    limits: crawlMetadataLimits(),
    stats: {
      pagesVisited: 0,
      nodesFound: 0,
      suggestedFlowsCount: 0,
      llmCallCount: 0,
    },
    error: err,
    diagnostics: {
      bfsPagesDiscovered: 0,
      afterShallowTrim: 0,
      afterRouteFilter: 0,
      hints: ["The scan failed before recording pages. See the error above."],
    },
  };
}

function recordCrawlLlmCall(
  calls: LLMCallRecord[],
  seqRef: { current: number },
  args: {
    agent: "crawl_route_filter" | "crawl_suggested_flows";
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

/** During BFS: enqueue same-origin links that pass the rule-based filter only (no LLM). */
function ruleOnlyEnqueueLinks(navLinks: string[], baseOrigin: string, auth: AuthConfig | null): string[] {
  const fullUrls = [...new Set(navLinks.map(l => toFullUrl(l, baseOrigin)))];
  return fullUrls.filter(u => !ruleBasedRejectLink(u, baseOrigin, auth));
}

function routeSegmentDepth(route: string): number {
  return route.split("/").filter(Boolean).length;
}

/** If more than `maxRoutes` pages, keep those with the shallowest normalized routes (fewest path segments). */
function trimSitemapToShallowestRoutes(pages: CrawlPageData[], maxRoutes: number): CrawlPageData[] {
  // Always return a copy: callers do `sitemap.length = 0; sitemap.push(...trimmed)`. Returning `pages` when
  // `pages === sitemap` would clear the same array reference and wipe the crawl before route-filter / LLM.
  if (pages.length <= maxRoutes) return [...pages];
  return [...pages]
    .sort((a, b) => {
      const da = routeSegmentDepth(a.route);
      const db = routeSegmentDepth(b.route);
      if (da !== db) return da - db;
      return a.route.length - b.route.length;
    })
    .slice(0, maxRoutes);
}

function parseKeepRoutesJson(raw: string): string[] | null {
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
}

type RouteFilterBatchResult = {
  batchIndex: number;
  totalBatches: number;
  keptRoutes: string[];
  raw: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  requestMessages: LLMStoredMessage[];
  querySummary: string;
  outcome: "ok" | "parse_failed" | "route_mismatch" | "empty_keep" | "error";
  error?: string;
};

async function classifyRoutesWebappBatch(
  batch: CrawlPageData[],
  baseUrl: string,
  batchIndex: number,
  totalBatches: number,
  model: string,
): Promise<RouteFilterBatchResult> {
  const routeSet = new Set(batch.map(p => p.route));
  const lines = batch
    .map((p, i) => {
      const hints = [p.forms.length > 0 ? "FORM" : "", p.interactions.length > 0 ? "MODAL" : ""].filter(Boolean).join(",") || "—";
      return `${i + 1}. ${p.route} | ${JSON.stringify(p.title || "")} | ${hints}`;
    })
    .join("\n");

  const prompt = `You filter routes for **automated QA of a web application**.

Kery is built for **interactive product UIs**: SaaS, internal tools, dashboards, authenticated apps — not blogs, news sites, marketing homepages, help centers, or read-only content hubs.

For each line below, decide whether this route is worth keeping for **functional product QA** (settings, workflows, data screens, modals, forms in the app).

**KEEP**: app surfaces the user operates in (CRUD, config, billing, team, integrations, etc.).
**REJECT**: blog posts, articles, docs, press, careers landing, legal-only pages, tag/category archives, and similar non-app content.

Site base: ${baseUrl}

${lines}

Return ONLY valid JSON, no markdown: {"keep":["/route1","/route2"]}
Each string in "keep" MUST match a ROUTE from the list **exactly** (the path segment immediately after the number and period, before the first " | ").`;

  const requestMessages: LLMStoredMessage[] = [{ role: "user", content: prompt }];
  const querySummary = `route-filter batch ${batchIndex}/${totalBatches} (${batch.length} routes)`;

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(
      [{ role: "user", content: prompt }],
      model,
      { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.1 },
    );
    const durationMs = Date.now() - t0;
    const fromModel = parseKeepRoutesJson(raw ?? "");
    let outcome: RouteFilterBatchResult["outcome"];
    let keptRoutes: string[];
    if (fromModel == null) {
      logger.warn({ batchSize: batch.length }, "Crawl: route-filter LLM parse failed, keeping batch");
      outcome = "parse_failed";
      keptRoutes = [...routeSet];
    } else {
      const filtered = fromModel.filter(r => routeSet.has(r));
      // Fail-open the whole batch if the model keeps nothing: empty {"keep":[]} is valid JSON
      // but would wipe the crawl (e.g. HN classified as "not a web app"). Same if strings don't match routes.
      if (filtered.length === 0) {
        if (fromModel.length > 0) {
          logger.warn({ batchSize: batch.length }, "Crawl: route-filter LLM returned no exact route matches, keeping batch");
          outcome = "route_mismatch";
        } else {
          logger.warn({ batchSize: batch.length }, "Crawl: route-filter LLM returned empty keep list, keeping batch");
          outcome = "empty_keep";
        }
        keptRoutes = [...routeSet];
      } else {
        outcome = "ok";
        keptRoutes = filtered;
      }
    }
    return {
      batchIndex,
      totalBatches,
      keptRoutes,
      raw: raw ?? "",
      usage,
      durationMs,
      requestMessages,
      querySummary,
      outcome,
    };
  } catch (err) {
    const msg = String(err);
    logger.warn({ err: msg, batchSize: batch.length }, "Crawl: route-filter LLM failed, keeping batch");
    return {
      batchIndex,
      totalBatches,
      keptRoutes: [...routeSet],
      raw: `ERROR: ${msg}`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
      requestMessages,
      querySummary,
      outcome: "error",
      error: msg,
    };
  }
}

/**
 * Parallel LLM batches over visited routes; drops non-webapp / content noise. Fail-open if nothing left.
 * Costs accrue under linkFilterUsd for persisted breakdown compatibility.
 */
async function filterSitemapRoutesWithLlmParallel(
  pages: CrawlPageData[],
  baseUrl: string,
  costAccum: CrawlCostAccum,
  llmCalls: LLMCallRecord[],
  seqRef: { current: number },
): Promise<CrawlPageData[]> {
  if (pages.length === 0) return [];
  const config = getConfig();
  const batches: CrawlPageData[][] = [];
  for (let i = 0; i < pages.length; i += ROUTE_FILTER_LLM_BATCH_SIZE) {
    batches.push(pages.slice(i, i + ROUTE_FILTER_LLM_BATCH_SIZE));
  }
  const totalBatches = batches.length;
  const settled = await Promise.all(
    batches.map((batch, bi) => classifyRoutesWebappBatch(batch, baseUrl, bi + 1, totalBatches, config.auxiliaryModel)),
  );
  settled.sort((a, b) => a.batchIndex - b.batchIndex);

  const allKept = new Set<string>();
  for (const r of settled) {
    const delta =
      r.usage.totalTokens > 0
        ? calcCostUsd(config.auxiliaryModel, r.usage.inputTokens, r.usage.outputTokens, "auxiliaryModel")
        : 0;
    costAccum.usd += delta;
    costAccum.linkFilterUsd += delta;
    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_route_filter",
      model: config.auxiliaryModel,
      query: r.querySummary,
      requestMessages: r.requestMessages,
      response: r.raw,
      usage: r.usage,
      durationMs: r.durationMs,
      costUsd: delta,
      stepIndex: r.batchIndex,
      crawlContext: {
        phase: "route_filter",
        batchIndex: r.batchIndex,
        totalBatches: r.totalBatches,
        batchSize: batches[r.batchIndex - 1]?.length ?? 0,
        outcome: r.outcome,
        keptCount: r.keptRoutes.length,
        ...(r.error ? { error: r.error } : {}),
      },
    });
    for (const route of r.keptRoutes) allKept.add(route);
  }

  const filtered = pages.filter(p => allKept.has(p.route));
  if (filtered.length === 0) {
    logger.warn({ pageCount: pages.length }, "Crawl: route filter kept zero pages, fail-open to trimmed set");
    return pages;
  }
  return filtered;
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
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, [], [], [], {
        error: "Invalid base URL",
        diagnostics: {
          bfsPagesDiscovered: 0,
          afterShallowTrim: 0,
          afterRouteFilter: 0,
          hints: [
            "The environment base URL could not be parsed. Use a full URL including scheme, e.g. https://your-app.com",
          ],
        },
      }),
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
    const { ok: authed } = await handleAuth(page, auth, undefined, baseUrl);
    if (authed) {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    } else {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }

    const startUrl = page.url();
    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
    if (startUrl !== baseUrl) queue.push({ url: baseUrl, depth: 1 });

    while (queue.length > 0 && sitemap.length < MAX_CRAWL_PAGES) {
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
                const authResult = await handleAuth(page, auth, undefined, baseUrl);
                if (!authResult.ok) {
                  logger.warn("Crawl: re-auth returned not ok, skipping login page");
                  continue;
                }
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

        const filteredLinks = ruleOnlyEnqueueLinks(pageData.navLinks, baseOrigin, auth);

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

    const bfsPagesDiscovered = sitemap.length;
    const trimmed = trimSitemapToShallowestRoutes(sitemap, MAX_APP_ROUTES);
    const afterShallowTrim = trimmed.length;
    sitemap.length = 0;
    sitemap.push(...trimmed);

    await emitProgress("route_filter", {
      queueDepth: queue.length,
      currentUrl: null,
      currentRoute: null,
    });

    const afterRouteLlm = await filterSitemapRoutesWithLlmParallel(
      [...sitemap], baseUrl, costAccum, llmCalls, seqRef,
    );
    const afterRouteFilter = afterRouteLlm.length;
    sitemap.length = 0;
    sitemap.push(...afterRouteLlm);

    await emitProgress("suggested_flows", {
      queueDepth: queue.length,
      currentUrl: null,
      currentRoute: null,
    });

    const suggestedFlows = await clusterIntoFlows(
      sitemap, existingTestNames, baseUrl, costAccum, llmCalls, seqRef,
    );

    const hints: string[] = [];
    if (bfsPagesDiscovered === 0) {
      try {
        const loadedOrigin = new URL(page.url()).origin;
        if (loadedOrigin !== baseOrigin) {
          hints.push(
            `Origin mismatch: after navigation the browser is on ${loadedOrigin}, but your environment base URL is ${baseOrigin}. ` +
              "The crawler only keeps same-origin pages. Set the environment base URL to the final origin after redirects (for example https://news.ycombinator.com, not https://hackernews.com).",
          );
        } else {
          hints.push(
            "No pages were recorded during the browser crawl. Common causes: stuck on a login screen without auth configured, navigation timeouts, blocked requests in the crawler environment, or no in-scope links passed the rule filter.",
          );
        }
      } catch {
        hints.push("No pages were discovered during the browser crawl.");
      }
      hints.push(
        "With zero pages, route filtering and suggested flows are skipped — so LLM cost stays at zero.",
      );
    } else if (afterRouteFilter === 0 && bfsPagesDiscovered > 0) {
      hints.push(
        "Every page was dropped after route filtering despite fail-open safeguards — check server logs and crawl_metadata LLM responses.",
      );
    }

    const diagnostics: CrawlMetadata["diagnostics"] = {
      bfsPagesDiscovered,
      afterShallowTrim,
      afterRouteFilter,
      hints,
    };

    return {
      status: "completed", pagesVisited: sitemap.length,
      nodesFound: sitemap.length + sitemap.reduce((acc, p) => acc + p.interactions.length, 0),
      destinationsBuilt: sitemap.length, sitemap, suggestedFlows,
      costUsd: costAccum.usd, llmCostBreakdown: breakdownFromAccum(costAccum),
      llmCalls,
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, sitemap, suggestedFlows, llmCalls, {
        diagnostics,
      }),
    };
  } catch (err) {
    const msg = String(err);
    return {
      status: "failed", pagesVisited: sitemap.length, nodesFound: 0, destinationsBuilt: 0,
      sitemap, suggestedFlows: [], costUsd: costAccum.usd, llmCostBreakdown: breakdownFromAccum(costAccum),
      llmCalls,
      crawlMetadata: buildCrawlMetadata(baseUrl, crawlStartedAt, sitemap, [], llmCalls, {
        error: msg,
        diagnostics: {
          bfsPagesDiscovered: sitemap.length,
          afterShallowTrim: sitemap.length,
          afterRouteFilter: sitemap.length,
          hints: [`Crawl aborted with an error: ${msg.slice(0, 500)}`],
        },
      }),
      error: msg,
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

  const prompt = `You are a QA engineer for **web applications** (SaaS, dashboards, product UIs — not content/marketing sites).

Review this sitemap of discovered **app routes** and suggest the most valuable **functional** test flows (user workflows, forms, critical paths). Max 15 suggestions.

Existing tests (skip overlapping ideas): ${existingTestNames.length > 0 ? existingTestNames.join(", ") : "(none)"}

Sitemap:
${sitemapText}

Return ONLY a JSON array: [{"name":"Short name","intent":"Step-by-step instructions starting from ${baseUrl}","discoveredRoute":"/route"}]`;

  const requestMessages: LLMStoredMessage[] = [{ role: "user", content: prompt }];

  try {
    const t0 = Date.now();
    const { content: raw, usage } = await llmChat(
      [{ role: "user", content: prompt }],
      config.auxiliaryModel,
      { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 },
    );
    const durationMs = Date.now() - t0;
    const delta = calcCostUsd(config.auxiliaryModel, usage.inputTokens, usage.outputTokens, "auxiliaryModel");
    costAccum.usd += delta;
    costAccum.suggestedFlowsUsd += delta;

    recordCrawlLlmCall(llmCalls, seqRef, {
      agent: "crawl_suggested_flows",
      model: config.auxiliaryModel,
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
      model: config.auxiliaryModel,
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
    const { content, usage } = await llmChat([{ role: "user", content: prompt }], config.auxiliaryModel, { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 });
    if (costAccum) costAccum.usd += calcCostUsd(config.auxiliaryModel, usage.inputTokens, usage.outputTokens, "auxiliaryModel");
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
      crawl_metadata_json: result.crawlMetadata,
      completed_at: new Date().toISOString(),
    });

    await browser.close();
    return { crawlRunId, result };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const lastSnapshot = lastSnapshotRef.current;
    const errStr = String(err);
    if (lastSnapshot) {
      await storage.updateCrawlRun(crawlRunId, {
        status: "failed",
        completed_at: completedAt,
        pages_visited: lastSnapshot.pagesVisited,
        nodes_found: lastSnapshot.nodesFound,
        sitemap_json: lastSnapshot.sitemap,
        cost_usd: lastSnapshot.costUsd,
        llm_cost_breakdown_json: lastSnapshot.llmCostBreakdown,
        crawl_metadata_json: {
          ...lastSnapshot.crawlMetadataPartial,
          inProgress: false,
          error: errStr,
          finishedAt: completedAt,
        },
      }).catch(() => {});
    } else {
      const startedAt =
        typeof (runRow as { started_at?: string }).started_at === "string"
          ? (runRow as { started_at: string }).started_at
          : completedAt;
      await storage
        .updateCrawlRun(crawlRunId, {
          status: "failed",
          completed_at: completedAt,
          crawl_metadata_json: minimalFailedCrawlMetadata(
            rewriteForDocker(env.base_url),
            startedAt,
            completedAt,
            errStr,
          ),
        })
        .catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}
