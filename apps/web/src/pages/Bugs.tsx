import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Bug,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Calendar,
  Globe,
  ListOrdered,
  Image as ImageIcon,
  Server,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import { fetchProjectBugs } from "../projectApi";

export type BugRecord = {
  name: string;
  description: string;
  category: "visual" | "functional" | "ux" | "other";
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  screenshotBase64?: string | null;
  stepsToReproduce: string[];
  url?: string | null;
  runId: string;
  runLabel?: string | null;
  reportedAt: string;
  environment?: string | null;
  index?: number;
};

function severityClass(severity: string): string {
  switch (severity) {
    case "high":
      return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400";
    case "medium":
      return "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400";
    default:
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400";
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400";
    case "in_progress":
      return "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400";
    case "wont_fix":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400";
  }
}

function formatReportedAt(iso: string): string {
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

export const Bugs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject } = useProject();
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] }));
    setBugs(res.bugs ?? []);
    setLoading(false);
  }

  React.useEffect(() => {
    load();
  }, [currentProjectId]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center gap-2 px-8 h-14 border-b border-border bg-card flex-shrink-0">
          <Bug className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Bugs</span>
        </div>
        <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
          <Bug className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-[13px] text-muted-foreground">Create or select a project to view bugs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex items-center justify-between px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-destructive" />
          <span className="text-sm font-semibold text-foreground">Bugs</span>
          {currentProject && (
            <span className="text-[11px] text-muted-foreground hidden sm:inline">-- {currentProject.name}</span>
          )}
          {!loading && bugs.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground ml-1">{bugs.length}</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={load} className="gap-1.5 h-8">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-6 max-w-4xl mx-auto w-full">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-24 rounded-lg border border-border bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : bugs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center rounded-lg border border-dashed border-border">
              <Bug className="h-10 w-10 text-muted-foreground/30 mb-4" />
              <p className="text-[13px] font-medium text-foreground">No bugs yet</p>
              <p className="text-[12px] text-muted-foreground mt-1 max-w-sm">
                Bugs are reported by the agent during test runs. Run a test to start finding issues.
              </p>
              <Button size="sm" className="mt-4" onClick={() => navigate("/tests")}>
                Go to Flows
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {bugs.map((bug, i) => {
                const id = `${bug.runId}-${bug.index ?? i}`;
                const isExpanded = expandedId === id;
                return (
                  <div
                    key={id}
                    className={cn(
                      "rounded-lg border border-border bg-card overflow-hidden",
                      isExpanded && "ring-1 ring-border"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      )}
                      <Bug className="h-4 w-4 text-destructive flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-foreground truncate">{bug.name}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="secondary" className="text-[10px] font-medium capitalize">
                            {bug.category}
                          </Badge>
                          <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", severityClass(bug.severity))}>
                            {bug.severity}
                          </span>
                          <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusClass(bug.status))}>
                            {bug.status.replace("_", " ")}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatReportedAt(bug.reportedAt)}
                          </span>
                          {bug.environment && (
                            <span className="text-[11px] text-muted-foreground">\u00b7 {bug.environment}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] gap-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/runs/${bug.runId}`);
                        }}
                      >
                        Run <ExternalLink className="h-3 w-3" />
                      </Button>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/20">
                        {bug.description && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                              Description
                            </p>
                            <p className="text-[13px] text-foreground whitespace-pre-wrap">{bug.description}</p>
                          </div>
                        )}

                        {bug.stepsToReproduce.length > 0 && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
                              <ListOrdered className="h-3 w-3" />
                              Steps to reproduce
                            </p>
                            <ol className="list-decimal list-inside space-y-1 text-[13px] text-foreground">
                              {bug.stepsToReproduce.map((step, j) => (
                                <li key={j}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {bug.screenshotBase64 && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
                              <ImageIcon className="h-3 w-3" />
                              Screenshot
                            </p>
                            <img
                              src={`data:image/jpeg;base64,${bug.screenshotBase64}`}
                              alt="Bug screenshot"
                              className="rounded-lg border border-border max-w-full max-h-[320px] object-contain bg-black/5"
                            />
                          </div>
                        )}

                        <div className="flex flex-wrap gap-4 text-[12px] text-muted-foreground">
                          {bug.environment && (
                            <span className="flex items-center gap-1">
                              <Server className="h-3.5 w-3.5 flex-shrink-0" />
                              Environment: {bug.environment}
                            </span>
                          )}
                          {bug.url && (
                            <a
                              href={bug.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 hover:text-foreground truncate max-w-full"
                            >
                              <Globe className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate">{bug.url}</span>
                              <ExternalLink className="h-3 w-3 flex-shrink-0" />
                            </a>
                          )}
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            {new Date(bug.reportedAt).toLocaleString()}
                          </span>
                          {bug.runLabel && (
                            <span>
                              Run: {bug.runLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
