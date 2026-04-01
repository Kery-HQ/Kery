export function statusVariant(status: string): "success" | "destructive" | "warning" | "neutral" {
  switch (status) {
    case "passed": return "success";
    case "failed": return "destructive";
    case "running": case "queued": return "warning";
    default: return "neutral";
  }
}

export function duration(started?: string, completed?: string): string {
  if (!started) return "—";
  const s = new Date(started).getTime();
  const e = completed ? new Date(completed).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Crawl LLM cost as a single total (USD). */
export function formatCrawlLlmCostLine(run: {
  cost_usd?: number | null;
  llm_cost_breakdown_json?: { linkFilterUsd?: number; suggestedFlowsUsd?: number } | null;
}): string | null {
  const total = run.cost_usd != null ? Number(run.cost_usd) : NaN;
  if (Number.isNaN(total) || total <= 0) return null;
  return formatCost(total);
}

/** Best-effort run cost: stored `cost_usd` or sum of `llm_calls_json[].costUsd`. */
export function runCostUsd(run: { cost_usd?: number | null; llm_calls_json?: unknown }): number {
  if (run.cost_usd != null) {
    const n = Number(run.cost_usd);
    if (!Number.isNaN(n)) return n;
  }
  const calls = run.llm_calls_json;
  if (!Array.isArray(calls)) return 0;
  return calls.reduce(
    (s: number, c: unknown) =>
      s + (typeof c === "object" && c !== null && "costUsd" in c && typeof (c as { costUsd?: number }).costUsd === "number"
        ? (c as { costUsd: number }).costUsd
        : 0),
    0,
  );
}

export function formatRunCost(run: { cost_usd?: number | null; llm_calls_json?: unknown }): string {
  return formatCost(runCostUsd(run));
}

/** Primary line for run lists: resolved test/page/adhoc name, else first summary line (e.g. errors). */
export function runListLabel(run: {
  summary?: string | null;
  display_name?: string | null;
  source_label?: string | null;
}): string {
  const named = (run.display_name ?? run.source_label ?? "").trim();
  if (named) return named;
  const summaryLine = run.summary?.split("\n")[0]?.trim();
  if (summaryLine) return summaryLine;
  return "—";
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatReportedAt(iso?: string | null): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return relativeTime(iso);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
