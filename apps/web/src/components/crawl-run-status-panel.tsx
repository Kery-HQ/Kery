import React from "react";
import { CheckCircle, Circle, Spinner, WarningCircle, Info } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatCost, duration } from "@/lib/formatters";

/** Row shape from scan status, pages lastScan, or crawl history. */
export type CrawlRunPanelRun = {
  id?: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  pages_visited?: number | null;
  nodes_found?: number | null;
  cost_usd?: number | null;
  llm_cost_breakdown_json?: { linkFilterUsd?: number; suggestedFlowsUsd?: number } | null;
  crawl_metadata_json?: CrawlRunPanelMeta | null;
};

export type CrawlRunPanelMeta = {
  phase?: string;
  inProgress?: boolean;
  baseUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  limits?: Record<string, unknown>;
  stats?: {
    pagesVisited?: number;
    nodesFound?: number;
    suggestedFlowsCount?: number;
    llmCallCount?: number;
  };
  live?: {
    queueDepth?: number;
    currentUrl?: string | null;
    currentRoute?: string | null;
  };
  error?: string;
  diagnostics?: {
    bfsPagesDiscovered: number;
    afterShallowTrim: number;
    afterRouteFilter: number;
    hints: string[];
  };
};

const PIPELINE: { key: string; label: string; detail: string; matchPhase: string | null }[] = [
  {
    key: "crawl",
    label: "Browser crawl",
    detail: "Playwright BFS, same-origin links, rule-based queue (no LLM).",
    matchPhase: "crawling",
  },
  {
    key: "trim_filter",
    label: "Shallow cap & route filter",
    detail: "Keep up to max app routes (shallow paths win), then parallel LLM to drop non–web-app pages.",
    matchPhase: "route_filter",
  },
  {
    key: "flows",
    label: "Suggested test flows",
    detail: "One LLM pass over the final sitemap.",
    matchPhase: "suggested_flows",
  },
  {
    key: "tree",
    label: "Build app tree",
    detail: "Destinations saved to your project.",
    matchPhase: null,
  },
];

function phaseLabel(phase?: string): string {
  if (phase === "suggested_flows") return "Suggested flows (LLM)";
  if (phase === "route_filter") return "Route filter (LLM)";
  if (phase === "crawling") return "Crawling pages";
  return "Starting…";
}

/** Active step index while status is running (0..2); tree is step 3. */
function activePipelineIndex(phase: string | undefined): number {
  if (phase === "suggested_flows") return 2;
  if (phase === "route_filter") return 1;
  return 0;
}

function formatLlmLine(run: CrawlRunPanelRun): string | null {
  const b = run.llm_cost_breakdown_json;
  if (!b) return null;
  const route = b.linkFilterUsd ?? 0;
  const flows = b.suggestedFlowsUsd ?? 0;
  const t = route + flows;
  if (t <= 0 && (run.cost_usd == null || run.cost_usd <= 0)) return null;
  const parts: string[] = [];
  if (route > 0) parts.push(`routes ${formatCost(route)}`);
  if (flows > 0) parts.push(`flows ${formatCost(flows)}`);
  if (parts.length === 0 && run.cost_usd != null && run.cost_usd > 0) return formatCost(Number(run.cost_usd));
  return parts.join(" · ");
}

type CrawlRunStatusPanelProps = {
  run: CrawlRunPanelRun | null;
  /** live = in-flight (spinner, current phase); summary = finished snapshot */
  variant: "live" | "summary";
  title?: string;
  className?: string;
};

export function CrawlRunStatusPanel({ run, variant, title, className }: CrawlRunStatusPanelProps) {
  const meta = run?.crawl_metadata_json;
  const running = variant === "live" && (run?.status === "running" || !run?.id);
  const phase = meta?.phase;
  const activeIdx = running ? activePipelineIndex(phase) : -1;
  const stats = meta?.stats;
  const pagesLive = typeof run?.pages_visited === "number" ? run.pages_visited : stats?.pagesVisited;
  const nodesLive = typeof run?.nodes_found === "number" ? run.nodes_found : stats?.nodesFound;
  const llmCalls = stats?.llmCallCount;
  const diag = meta?.diagnostics;

  return (
    <Card
      className={cn(
        "border overflow-hidden",
        running ? "border-primary/25 bg-primary/[0.04]" : "border-border bg-surface-2/40",
        className,
      )}
    >
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {running ? (
              <Spinner className="h-4 w-4 animate-spin text-primary flex-shrink-0 mt-0.5" />
            ) : run?.status === "failed" ? (
              <WarningCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle className="h-4 w-4 text-status-pass flex-shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground leading-tight">
                {title ??
                  (running ? "Scan in progress" : run?.status === "failed" ? "Scan failed" : "Last scan")}
              </p>
              {!!run?.started_at && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {running ? (
                    <>
                      {phaseLabel(phase)} · {duration(run.started_at)} elapsed
                    </>
                  ) : run.completed_at ? (
                    <>
                      {relativeShort(run.completed_at)} · {duration(run.started_at, run.completed_at)} total
                    </>
                  ) : (
                    <>Started {relativeShort(run.started_at)}</>
                  )}
                </p>
              )}
            </div>
          </div>
          {run?.status && (
            <Badge
              variant={run.status === "failed" ? "destructive" : run.status === "running" ? "secondary" : "outline"}
              className="capitalize shrink-0 text-[10px] h-5"
            >
              {run.status}
            </Badge>
          )}
        </div>

        {/* Pipeline */}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
            Pipeline
          </p>
          <ol className="space-y-2">
            {PIPELINE.map((step, i) => {
              const isTree = step.key === "tree";
              let done: boolean;
              let active: boolean;
              if (isTree) {
                active = false;
                done = !running && run?.status === "completed";
              } else if (running) {
                active = i === activeIdx;
                done = i < activeIdx;
              } else {
                active = false;
                done = run?.status === "completed";
              }

              let icon: React.ReactNode;
              if (isTree) {
                if (done) icon = <CheckCircle className="h-3.5 w-3.5 text-status-pass" />;
                else if (!running && run?.status === "failed")
                  icon = <WarningCircle className="h-3.5 w-3.5 text-muted-foreground/50" />;
                else icon = <Circle className="h-3.5 w-3.5 text-muted-foreground/35" />;
              } else if (done) {
                icon = <CheckCircle className="h-3.5 w-3.5 text-status-pass" />;
              } else if (active) {
                icon = <Spinner className="h-3.5 w-3.5 animate-spin text-primary" />;
              } else {
                icon = <Circle className="h-3.5 w-3.5 text-muted-foreground/35" />;
              }

              return (
                <li key={step.key} className="flex gap-2.5">
                  <span className="mt-0.5 flex-shrink-0">{icon}</span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-[12px] font-medium leading-snug",
                        active ? "text-foreground" : "text-foreground/85",
                      )}
                    >
                      {step.label}
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{step.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <Separator className="opacity-50" />

        {/* Live crawl context */}
        {running && meta?.live && (meta.live.currentRoute || typeof meta.live.queueDepth === "number") && (
          <div className="rounded-md border border-border/80 bg-muted/15 px-3 py-2 space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Current</p>
            {meta.live.currentRoute && (
              <p className="text-[11px] font-mono truncate text-foreground/90" title={meta.live.currentUrl ?? undefined}>
                {meta.live.currentRoute}
              </p>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground font-mono tabular-nums">
              {typeof meta.live.queueDepth === "number" && <span>Queue {meta.live.queueDepth}</span>}
              {typeof pagesLive === "number" && (
                <span>
                  Pages {pagesLive}
                  {typeof nodesLive === "number" && <> · Nodes {nodesLive}</>}
                </span>
              )}
              {typeof llmCalls === "number" && llmCalls > 0 && <span>LLM calls {llmCalls}</span>}
            </div>
          </div>
        )}

        {/* Metrics grid */}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">Metrics</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2 text-[11px]">
            <Metric
              label="BFS pages"
              value={
                diag != null
                  ? String(diag.bfsPagesDiscovered)
                  : pagesLive != null
                    ? String(pagesLive)
                    : "—"
              }
            />
            <Metric
              label="After shallow cap"
              value={diag ? String(diag.afterShallowTrim) : "—"}
              muted={!diag}
            />
            <Metric
              label="After route filter"
              value={diag ? String(diag.afterRouteFilter) : "—"}
              muted={!diag}
            />
            <Metric label="Pages (stored)" value={run?.pages_visited != null ? String(run.pages_visited) : "—"} />
            <Metric label="LLM calls" value={llmCalls != null ? String(llmCalls) : stats?.llmCallCount != null ? String(stats.llmCallCount) : "—"} />
            <Metric
              label="LLM cost"
              value={formatLlmLine(run ?? ({} as CrawlRunPanelRun)) ?? (run?.cost_usd != null && run.cost_usd > 0 ? formatCost(Number(run.cost_usd)) : "—")}
            />
          </div>
        </div>

        {meta?.baseUrl && (
          <p className="text-[10px] text-muted-foreground font-mono break-all">
            Base URL <span className="text-foreground/80">{meta.baseUrl}</span>
          </p>
        )}

        {meta?.limits && Object.keys(meta.limits).length > 0 && (
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer font-medium text-muted-foreground/90 hover:text-foreground">
              Crawl limits
            </summary>
            <pre className="mt-2 p-2 rounded-md border border-border/60 bg-muted/10 overflow-x-auto text-[10px] leading-relaxed">
              {JSON.stringify(meta.limits, null, 2)}
            </pre>
          </details>
        )}

        {meta?.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 flex gap-2">
            <WarningCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-destructive">Error</p>
              <p className="text-[11px] text-foreground/90 whitespace-pre-wrap break-words mt-0.5">{meta.error}</p>
            </div>
          </div>
        )}

        {diag?.hints && diag.hints.length > 0 && (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-200/90">
              <Info className="h-3.5 w-3.5" />
              Why you might see this result
            </div>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-muted-foreground leading-relaxed">
              {diag.hints.map((h, i) => (
                <li key={i} className="marker:text-amber-600/80 dark:marker:text-amber-400/80">
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}

      </CardContent>
    </Card>
  );
}

function Metric({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground/80 uppercase tracking-wide">{label}</p>
      <p className={cn("font-mono tabular-nums text-[12px]", muted && "text-muted-foreground")}>{value}</p>
    </div>
  );
}

function relativeShort(iso: string): string {
  const t = new Date(iso).getTime();
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
