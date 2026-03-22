import React from "react";
import { useNavigate } from "react-router-dom";
import { LayoutDashboard, Activity, ChevronRight, AlertCircle, ExternalLink } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import { fetchProjectRuns, fetchProjectBugs } from "../projectApi";

type BugRecord = {
  runId: string;
  runSummary?: string;
  runDate?: string;
  name?: string;
  description?: string;
  category?: string;
  severity?: string;
  url?: string;
};

function statusVariant(status: string): "success" | "destructive" | "warning" | "neutral" {
  if (status === "passed")  return "success";
  if (status === "failed")  return "destructive";
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

function formatRelativeTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

const SEVERITY_BORDER: Record<string, string> = {
  high:   "border-l-red-500",
  medium: "border-l-orange-400",
  low:    "border-l-amber-400",
};

const SEVERITY_DOT: Record<string, string> = {
  high:   "bg-red-500",
  medium: "bg-orange-400",
  low:    "bg-amber-400",
};

export const Overview: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject } = useProject();

  const [recentRuns, setRecentRuns] = React.useState<any[]>([]);
  const [recentBugs, setRecentBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);
    Promise.all([
      fetchProjectRuns(currentProjectId),
      fetchProjectBugs(currentProjectId),
    ])
      .then(([runsRes, bugsRes]) => {
        setRecentRuns((runsRes.runs ?? []).slice(0, 20));
        const bugs = (bugsRes.bugs ?? []).slice(0, 10).map((b: any) => ({
          runId: b.runId,
          runDate: b.reportedAt,
          name: b.name,
          description: b.description,
          category: b.category,
          severity: b.severity,
          url: b.url,
        }));
        setRecentBugs(bugs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentProjectId]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader title="Overview" />
        <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
          <LayoutDashboard className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-[13px] text-muted-foreground">Create or select a project to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader title={currentProject?.name ?? "Overview"} />

      <div className="px-4 sm:px-6 lg:px-8 py-6 animate-fade-in w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full max-w-6xl mx-auto">
          {/* Recent Issues */}
          <Card className="min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Recent Issues
              </p>
              {recentBugs.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => navigate("/bugs")} className="h-7 text-[12px]">
                  View all <ChevronRight className="h-3 w-3 ml-1" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-14 rounded-lg border border-border bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : recentBugs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border border-dashed border-border">
                <AlertCircle className="h-6 w-6 text-muted-foreground/20 mb-3" />
                <p className="text-[13px] text-muted-foreground">No issues found yet</p>
                <p className="text-[12px] text-muted-foreground/60 mt-1">
                  Issues are reported when the agent finds problems during test runs.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentBugs.map((bug, i) => (
                  <button
                    key={`${bug.runId}-${i}`}
                    onClick={() => navigate(`/runs/${bug.runId}`)}
                    className={cn(
                      "group w-full flex items-start gap-3 px-4 py-2.5 rounded-lg border border-border border-l-[3px] bg-card text-left",
                      "hover:bg-accent/40 transition-colors",
                      SEVERITY_BORDER[bug.severity ?? "low"] ?? "border-l-muted-foreground/30",
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-foreground line-clamp-1">
                        {bug.name || bug.description || "Issue identified"}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {bug.severity && (
                          <span className="flex items-center gap-1">
                            <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_DOT[bug.severity] ?? "bg-muted-foreground/30")} />
                            <span className="text-[11px] text-muted-foreground capitalize">{bug.severity}</span>
                          </span>
                        )}
                        {bug.category && (
                          <span className="text-[11px] text-muted-foreground/70">{bug.category}</span>
                        )}
                        <span className="text-[11px] text-muted-foreground/50 ml-auto">
                          {formatRelativeTime(bug.runDate)}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground flex-shrink-0 mt-1" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
          </Card>

          {/* Recent runs */}
          <Card className="min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Recent runs
              </p>
              <Button size="sm" variant="ghost" onClick={() => navigate("/runs")} className="h-7 text-[12px]">
                View all <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-12 rounded-lg border border-border bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : recentRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 rounded-lg border border-dashed border-border text-center">
                <Activity className="h-6 w-6 text-muted-foreground/20 mb-3" />
                <p className="text-[13px] text-muted-foreground">No runs yet</p>
                <p className="text-[12px] text-muted-foreground/60 mt-1">
                  Go to Flows to run your first test flow.
                </p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={() => navigate("/tests")}>
                  Go to Flows
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border -mx-1">
                {recentRuns.slice(0, 10).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => navigate(`/runs/${r.id}`)}
                    className="group w-full flex items-center gap-3 px-4 py-2.5 -mx-1 rounded text-left hover:bg-accent/40 transition-colors"
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full flex-shrink-0",
                        r.status === "passed" ? "bg-emerald-500" :
                        r.status === "failed" ? "bg-destructive" :
                        r.status === "running" ? "bg-amber-400 animate-pulse" : "bg-muted-foreground/30",
                      )}
                    />
                    <Badge variant={statusVariant(r.status)} className="flex-shrink-0 text-[10px]">
                      {r.status}
                    </Badge>
                    <span className="flex-1 text-[12px] text-muted-foreground truncate min-w-0">
                      {r.summary?.split("\n")[0] ?? "--"}
                    </span>
                    {r.bugs_json?.length > 0 && (
                      <span className="text-[11px] text-orange-500 flex-shrink-0 font-medium">
                        {r.bugs_json.length} issue{r.bugs_json.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground/50 flex-shrink-0">
                      {duration(r.started_at, r.completed_at) || formatRelativeTime(r.completed_at ?? r.started_at)}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

function PageHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 sm:px-6 lg:px-8 h-14 border-b border-border flex-shrink-0">
      <LayoutDashboard className="h-4 w-4 text-muted-foreground/60" />
      <span className="text-[14px] font-semibold text-foreground tracking-tight">{title}</span>
    </div>
  );
}
