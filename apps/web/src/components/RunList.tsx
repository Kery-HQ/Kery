import React from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Clock, Bug } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

function statusVariant(status: string): "success" | "destructive" | "warning" | "neutral" {
  if (status === "passed") return "success";
  if (status === "failed") return "destructive";
  if (status === "running") return "warning";
  return "neutral";
}

function duration(started?: string, completed?: string): string {
  if (!started || !completed) return "";
  const ms = new Date(completed).getTime() - new Date(started).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function relativeTime(ts?: string): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type Run = {
  id: string;
  status: string;
  summary?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  bugs_json?: unknown[] | null;
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
          <div key={i} className="h-14 rounded-lg border border-border bg-card animate-pulse" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center">
        <p className="text-[13px] text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {title && (
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3 px-0.5">
          {title}
        </p>
      )}
      <div className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm overflow-hidden">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => navigate(`/runs/${r.id}`)}
            className="group w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-accent/50 transition-all duration-150"
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full flex-shrink-0",
                r.status === "passed" ? "bg-emerald-500" : r.status === "failed" ? "bg-destructive" : r.status === "running" ? "bg-amber-400 animate-pulse" : "bg-muted-foreground/30",
              )}
            />
            <span className="font-mono text-[11px] text-muted-foreground w-16 flex-shrink-0">{r.id.slice(0, 8)}</span>
            <Badge variant={statusVariant(r.status)} className="flex-shrink-0 text-[10px]">
              {r.status}
            </Badge>
            <span className="flex-1 text-[12px] text-muted-foreground truncate min-w-0">{r.summary?.split("\n")[0] ?? ""}</span>
            {r.bugs_json && r.bugs_json.length > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-red-500 flex-shrink-0">
                <Bug className="h-3 w-3" />
                {r.bugs_json.length}
              </span>
            )}
            <div className="flex items-center gap-3 flex-shrink-0 text-[11px] text-muted-foreground/50">
              {duration(r.started_at ?? undefined, r.completed_at ?? undefined) && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {duration(r.started_at ?? undefined, r.completed_at ?? undefined)}
                </span>
              )}
              <span>{relativeTime(r.started_at ?? undefined)}</span>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
