import React from "react";
import { useNavigate } from "react-router-dom";
import { CaretRight, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { statusVariant, duration, relativeTime, formatRunCost, runListLabel } from "@/lib/formatters";

type Run = {
  id: string;
  status: string;
  summary?: string | null;
  display_name?: string | null;
  source_label?: string | null;
  trigger_ref?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  bugs_json?: unknown[] | null;
  cost_usd?: number | null;
  llm_calls_json?: unknown;
};

export function RunList({
  runs,
  title,
  loading,
  emptyMessage = "No runs yet",
}: {
  runs: Run[];
  title?: string;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-3.5">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState title={emptyMessage} className="py-12" />
    );
  }

  return (
    <div>
      {title && (
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
          {title}
        </p>
      )}
      <div className="liquid-glass rounded-xl overflow-hidden space-y-0.5 p-1">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => navigate(`/runs/${r.id}`)}
            className="glass-row group w-full flex items-center gap-3 px-4 py-2.5 text-left"
          >
            <StatusDot status={r.status} />
            <span className="font-mono text-[11px] text-muted-foreground w-[5.5rem] flex-shrink-0 truncate">
              {r.id.slice(0, 8)}
            </span>
            <Badge variant={statusVariant(r.status)} dot className="flex-shrink-0 text-[10px]">
              {r.status}
            </Badge>
            {r.trigger_ref === "discovery" && (
              <Badge variant="outline" className="flex-shrink-0 text-[10px] gap-1">
                <MagnifyingGlassPlus className="h-2.5 w-2.5" />
                Discovery
              </Badge>
            )}
            <span className="flex-1 text-[13px] text-foreground truncate min-w-0">
              {runListLabel(r)}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 w-[4.25rem] text-right tabular-nums">
              {formatRunCost(r)}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground/60 flex-shrink-0">
              {duration(r.started_at ?? undefined, r.completed_at ?? undefined)}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground/40 flex-shrink-0">
              {relativeTime(r.started_at ?? undefined)}
            </span>
            <CaretRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
