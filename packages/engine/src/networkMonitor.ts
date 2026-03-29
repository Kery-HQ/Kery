import type { Page } from "playwright";
import type { NetworkBug } from "./types.js";
import { logger } from "./logger.js";
import { getTokenSession, refreshIfNeeded } from "./tokenAuth.js";

const MAX_CRITICAL_CONSOLE = 5;
const MAX_HTTP_ERRORS = 20;
const SLOW_RESPONSE_MS = 5000;
const MAX_SLOW_RESPONSES = 5;

function shouldTrackRequest(url: string): boolean {
  const noisy = [
    ".woff", ".woff2", ".ttf", ".ico",
    "fonts.googleapis.com", "analytics", "gtm.js", "hotjar", "sentry",
    "chrome-extension://", "moz-extension://",
  ];
  return !noisy.some((n) => url.includes(n));
}

function isImportantUrl(url: string): boolean {
  if (!shouldTrackRequest(url)) return false;
  if (/\/api\//i.test(url) || /graphql/i.test(url)) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)(\?|$)/i.test(url)) return false;
  return true;
}

function isCorsError(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("cors") || lower.includes("cross-origin") || lower.includes("access-control");
}

function isCriticalConsoleError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("load failed") ||
    lower.includes("uncaught") ||
    (lower.includes("error:") && !lower.includes("script error"))
  );
}

export type NetworkMonitorResult = {
  getBugs: () => NetworkBug[];
  stop: () => void;
};

export function attachNetworkMonitor(page: Page): NetworkMonitorResult {
  const bugs: NetworkBug[] = [];
  const seenKeys = new Set<string>();

  function addBug(bug: Omit<NetworkBug, "source">): void {
    const key = `${bug.type}|${bug.url ?? ""}|${bug.description.slice(0, 80)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    bugs.push({ ...bug, source: "network" });
    logger.debug({ type: bug.type, url: bug.url }, "NetworkMonitor: bug recorded");
  }

  let criticalConsoleCount = 0;
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 200);
    if (isCorsError(text)) {
      addBug({ type: "cors", description: text, severity: "high", at: Date.now() });
      return;
    }
    if (!isCriticalConsoleError(text)) return;
    if (criticalConsoleCount >= MAX_CRITICAL_CONSOLE) return;
    criticalConsoleCount++;
    addBug({ type: "console_error", description: text, severity: "medium", at: Date.now() });
  });

  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!isImportantUrl(url)) return;
    const failure = req.failure();
    const errorText = failure?.errorText ?? "failed";
    const shortUrl = url.slice(0, 120);
    addBug({
      type: "request_failed",
      description: `${errorText} \u2014 ${shortUrl}`,
      severity: "high",
      url: shortUrl,
      at: Date.now(),
    });
  });

  const responseStarts = new Map<string, number>();
  page.on("request", (req) => {
    const url = req.url();
    if (!shouldTrackRequest(url)) return;
    responseStarts.set(req.url(), Date.now());
  });

  let slowResponseCount = 0;
  page.on("response", (res) => {
    const url = res.url();
    if (!shouldTrackRequest(url)) return;
    const status = res.status();
    const started = responseStarts.get(url);
    responseStarts.delete(url);
    const durationMs = started != null ? Date.now() - started : undefined;
    const important = isImportantUrl(url);

    if (status >= 400 && bugs.filter((b) => b.type === "http_error").length < MAX_HTTP_ERRORS) {
      const is5xx = status >= 500;
      const isAuth = status === 401 || status === 403;
      const is4xxImportant = important && (status === 400 || status === 404 || status >= 405);

      // Auth-aware: if using token auth and we get 401/403, attempt refresh
      // before reporting as a bug
      if (isAuth && getTokenSession(page)) {
        refreshIfNeeded(page).catch(() => {});
        // Suppress the first 401/403 — the refresh will fix subsequent requests
        if (!seenKeys.has(`auth_refresh_attempted`)) {
          seenKeys.add(`auth_refresh_attempted`);
          logger.info({ status, url: url.slice(0, 100) }, "Auth error intercepted, token refresh triggered");
          return;
        }
      }

      if (is5xx || isAuth || is4xxImportant) {
        const severity = is5xx ? "high" : isAuth ? "medium" : "low";
        addBug({
          type: "http_error",
          description: `HTTP ${status} \u2014 ${url.slice(0, 100)}`,
          severity,
          url: url.slice(0, 200),
          statusCode: status,
          at: Date.now(),
        });
      }
    }

    if (
      important &&
      durationMs != null &&
      durationMs >= SLOW_RESPONSE_MS &&
      slowResponseCount < MAX_SLOW_RESPONSES
    ) {
      slowResponseCount++;
      addBug({
        type: "slow_response",
        description: `Slow response: ${(durationMs / 1000).toFixed(1)}s \u2014 ${url.slice(0, 80)}`,
        severity: "low",
        url: url.slice(0, 200),
        at: Date.now(),
      });
    }
  });

  return {
    getBugs: () => [...bugs],
    stop: () => {
      responseStarts.clear();
    },
  };
}
