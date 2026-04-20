import React from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { duration } from "@/lib/formatters";

type ScanPhase = "crawling" | "route_filter" | "suggested_flows" | undefined;

const PHASE_LABELS: Record<string, string> = {
  crawling: "Crawling routes",
  route_filter: "Filtering routes",
  suggested_flows: "Generating test flows",
};

const PHASE_PROGRESS: Record<string, number> = {
  crawling: 25,
  route_filter: 58,
  suggested_flows: 82,
};

function phaseProgress(
  phase: ScanPhase,
  pagesVisited: number | null | undefined,
  maxRoutes = 80,
): number {
  if (!phase) return 5;
  if (phase === "crawling") {
    const pages = pagesVisited ?? 0;
    const fill = Math.min(pages / maxRoutes, 1) * 28;
    return 5 + fill;
  }
  return PHASE_PROGRESS[phase] ?? 5;
}

export type ScanBannerRun = {
  status: string;
  started_at: string;
  completed_at?: string | null;
  pages_visited?: number | null;
  crawl_metadata_json?: {
    phase?: string;
    stats?: { pagesVisited?: number };
    live?: { currentRoute?: string | null };
    error?: string;
  } | null;
};

type Props = {
  run: ScanBannerRun;
  /** true = actively in-flight poll; false = static finished snapshot */
  live?: boolean;
  className?: string;
};

export function ScanBanner({ run, live = false, className }: Props) {
  const meta = run.crawl_metadata_json;
  const phase = meta?.phase as ScanPhase;
  const pagesVisited =
    typeof run.pages_visited === "number"
      ? run.pages_visited
      : meta?.stats?.pagesVisited;

  const progress = live ? phaseProgress(phase, pagesVisited) : 100;
  const phaseLabel = phase ? (PHASE_LABELS[phase] ?? phase) : "Starting…";
  const elapsed = duration(run.started_at);

  const isError = run.status === "failed" || !!meta?.error;

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 space-y-2.5",
        live
          ? "border-primary/25 bg-primary/[0.03]"
          : isError
            ? "border-destructive/25 bg-destructive/[0.03]"
            : "border-status-pass/30 bg-status-pass/[0.03]",
        className,
      )}
    >
      {/* Top row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {live ? (
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : isError ? (
            <WarningCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
          ) : (
            <CheckCircle className="h-3.5 w-3.5 text-status-pass flex-shrink-0" />
          )}
          <span className="text-[13px] font-medium text-foreground">
            {live ? "Scanning your app" : isError ? "Scan failed" : "Scan complete"}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
          {live ? `${elapsed} elapsed` : duration(run.started_at, run.completed_at ?? undefined)}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-700 ease-out",
            live ? "bg-primary" : isError ? "bg-destructive/60" : "bg-status-pass",
            live && progress < 95 && "origin-left",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Bottom row */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{live ? phaseLabel : ""}</span>
        {typeof pagesVisited === "number" && pagesVisited > 0 && (
          <span className="tabular-nums font-mono">
            {pagesVisited} route{pagesVisited !== 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
