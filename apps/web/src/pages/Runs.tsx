import React from "react";
import { useNavigate } from "react-router-dom";
import { Pulse, ArrowsClockwise } from "@phosphor-icons/react";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { statusVariant, duration, relativeTime, formatRunCost, runListLabel } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import { fetchProjectRuns } from "@/projectApi";

export const Runs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();

  const [runs, setRuns] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!currentProjectId) return;
    setLoading((prev) => runs.length === 0 ? true : prev);
    const res = await fetchProjectRuns(currentProjectId).catch(() => ({ runs: [] }));
    setRuns(res.runs ?? []);
    setLoading(false);
  }, [currentProjectId]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 5s while any run is running or queued
  React.useEffect(() => {
    const hasActive = runs.some((r) => r.status === "running" || r.status === "queued");
    if (!hasActive) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [runs, load]);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Pulse className="h-4 w-4" />} title="Runs">
        {!loading && runs.length > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground">{runs.length} runs</span>
        )}
        <Button variant="outline" size="sm" onClick={load} className="h-7 gap-1.5 text-[12px]">
          <ArrowsClockwise className="h-3 w-3" />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-6 py-6 animate-fade-in">
        {!currentProjectId ? (
          <EmptyState
            icon={<Pulse className="h-6 w-6" />}
            title="No project selected"
            description="Select a project to view runs."
          />
        ) : loading ? (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                    <Skeleton className="h-2 w-2 rounded-full" />
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-5 w-16 rounded-md" />
                    <Skeleton className="h-3 flex-1" />
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-10" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<Pulse className="h-6 w-6" />}
            title="No runs yet"
            description="Trigger a run from the Flows page to get started."
            action={{ label: "Go to Flows", onClick: () => navigate("/tests") }}
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {runs.map((r: any) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => navigate(`/runs/${r.id}`)}
                    className="group w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-accent/40 transition-colors"
                  >
                    <StatusDot status={r.status} />
                    <span className="font-mono text-[11px] text-muted-foreground w-[5.5rem] flex-shrink-0 truncate">
                      {r.id.slice(0, 8)}
                    </span>
                    <span className="flex-1 text-[13px] text-foreground truncate min-w-0">
                      {runListLabel(r)}
                    </span>
                    <Badge variant={statusVariant(r.status)} dot className="flex-shrink-0 text-[10px]">
                      {r.status}
                    </Badge>
                    <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 w-[4.25rem] text-right tabular-nums">
                      {formatRunCost(r)}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/60 flex-shrink-0 w-14 text-right">
                      {duration(r.started_at, r.completed_at)}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/40 flex-shrink-0 w-14 text-right">
                      {relativeTime(r.completed_at ?? r.started_at)}
                    </span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};
