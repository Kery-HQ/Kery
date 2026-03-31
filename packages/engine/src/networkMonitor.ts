import type { Page, Request, Response } from "playwright";
import type { NetworkBug } from "./types.js";
import { logger } from "./logger.js";
import { getTokenSession, refreshIfNeeded } from "./tokenAuth.js";

// ─── Filtering: only API / data requests ─────────────────────────────────────

const ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|avif|mp[34]|webm)(\?|$)/i;
const NOISY_RE = /fonts\.googleapis|analytics|gtm\.js|gtag|hotjar|sentry|intercom|segment|facebook|doubleclick|google-analytics|chrome-extension:|moz-extension:|_next\/static|__webpack_hmr|sockjs-node|hot-update/i;

function isApiRequest(url: string): boolean {
  return /\/api\//i.test(url) || /graphql/i.test(url) || /\/rest\//i.test(url);
}

function isTrackableRequest(url: string): boolean {
  if (NOISY_RE.test(url)) return false;
  if (ASSET_RE.test(url)) return false;
  return isApiRequest(url);
}

function isMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

// ─── Action-correlated network tracking ───────────────────────────────────────

export type NetworkMonitorResult = {
  /** Signal that a user-driven action is about to happen. Only network activity within an action window is tracked. */
  markActionStart: () => void;
  /** Signal that the action + settle period is complete. */
  markActionEnd: () => void;
  /** Get bugs found so far (action-correlated only). */
  getBugs: () => NetworkBug[];
  /** Concise hint for the agent observation (empty string when nothing relevant). */
  formatForAgent: () => string;
  stop: () => void;
};

const MAX_BUGS = 8;

export function attachNetworkMonitor(page: Page): NetworkMonitorResult {
  const bugs: NetworkBug[] = [];
  const seenKeys = new Set<string>();
  let insideAction = false;

  function addBug(bug: Omit<NetworkBug, "source">): void {
    if (bugs.length >= MAX_BUGS) return;
    const key = `${bug.type}|${bug.statusCode ?? ""}|${bug.url?.slice(0, 80) ?? ""}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    bugs.push({ ...bug, source: "network" });
    logger.debug({ type: bug.type, url: bug.url }, "NetworkMonitor: action-correlated bug");
  }

  const onRequestFailed = (req: Request) => {
    if (!insideAction) return;
    const url = req.url();
    if (!isTrackableRequest(url)) return;
    const failure = req.failure();
    const errorText = failure?.errorText ?? "failed";
    addBug({
      type: "request_failed",
      description: `${req.method()} ${url.slice(0, 80)} \u2014 ${errorText}`,
      severity: "high",
      url: url.slice(0, 200),
      at: Date.now(),
    });
  };

  const onResponse = (res: Response) => {
    if (!insideAction) return;
    const url = res.url();
    if (!isTrackableRequest(url)) return;
    const status = res.status();
    const req = res.request();
    const method = req.method();

    if (status === 401 || status === 403) {
      if (getTokenSession(page)) {
        refreshIfNeeded(page).catch(() => {});
        if (!seenKeys.has("auth_refresh_attempted")) {
          seenKeys.add("auth_refresh_attempted");
          return;
        }
      }
    }

    // 5xx on any tracked API call; 4xx only on mutating requests (skip noisy GET 404s, preflight, polling)
    const is5xx = status >= 500;
    const is4xxMutating = status >= 400 && status < 500 && isMutatingMethod(method);

    if (is5xx || is4xxMutating) {
      addBug({
        type: "http_error",
        description: `${method} ${url.slice(0, 80)} \u2192 HTTP ${status}`,
        severity: is5xx ? "high" : "medium",
        url: url.slice(0, 200),
        statusCode: status,
        at: Date.now(),
      });
    }
  };

  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return {
    markActionStart() { insideAction = true; },
    markActionEnd() { insideAction = false; },
    getBugs: () => [...bugs],
    formatForAgent(): string {
      if (bugs.length === 0) return "";
      const recent = bugs.slice(-3);
      const lines = recent.map(b => `  - ${b.description}`);
      return `NETWORK ISSUES (detected during your actions):\n${lines.join("\n")}\nThese may indicate application errors. Evaluate whether they relate to the current intent.`;
    },
    stop() {
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    },
  };
}
