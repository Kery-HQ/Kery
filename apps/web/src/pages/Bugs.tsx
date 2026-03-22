import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, ChevronDown, ChevronRight, ExternalLink,
  RefreshCw, Globe, ListOrdered, Image as ImageIcon, Server, Calendar,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatReportedAt } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import { fetchProjectBugs } from "@/projectApi";

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

const SEVERITY_FILTERS = ["all", "high", "medium", "low"] as const;
type SeverityFilter = (typeof SEVERITY_FILTERS)[number];

const CATEGORY_FILTERS = ["all", "visual", "functional", "ux", "other"] as const;
type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_DOT: Record<string, string> = {
  high: "error",
  medium: "warning",
  low: "stale",
};

const SEVERITY_VARIANT: Record<string, "destructive" | "warning" | "neutral"> = {
  high: "destructive",
  medium: "warning",
  low: "neutral",
};

const STATUS_VARIANT: Record<string, "success" | "warning" | "neutral" | "destructive"> = {
  open: "warning",
  in_progress: "warning",
  resolved: "success",
  wont_fix: "neutral",
};

const CATEGORY_VARIANT: Record<string, "default" | "neutral" | "outline"> = {
  visual: "outline",
  functional: "default",
  ux: "neutral",
  other: "neutral",
};

export const Bugs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = React.useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<CategoryFilter>("all");

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] }));
    setBugs(res.bugs ?? []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  const filteredBugs = React.useMemo(() => {
    let result = [...bugs];
    if (severityFilter !== "all") {
      result = result.filter(b => b.severity === severityFilter);
    }
    if (categoryFilter !== "all") {
      result = result.filter(b => b.category === categoryFilter);
    }
    result.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
    return result;
  }, [bugs, severityFilter, categoryFilter]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<AlertTriangle className="h-4 w-4" />} title="Issues" />
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="No project selected"
          description="Create or select a project to view issues."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<AlertTriangle className="h-4 w-4" />} title="Issues">
        {!loading && bugs.length > 0 && (
          <Badge variant="neutral" className="font-mono">{bugs.length}</Badge>
        )}
        <Button size="sm" variant="outline" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 max-w-4xl mx-auto w-full space-y-4 animate-fade-in">

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : bugs.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle className="h-8 w-8" />}
              title="No issues yet"
              description="Issues are reported by the agent during test runs. Run a test to start finding problems."
              action={{ label: "Go to Flows", onClick: () => navigate("/tests") }}
            />
          ) : (
            <>
              {/* Filter bar */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/50 mr-1">Severity</span>
                  {SEVERITY_FILTERS.map(s => (
                    <Button
                      key={s}
                      size="sm"
                      variant="ghost"
                      onClick={() => setSeverityFilter(s)}
                      className={cn(
                        "h-7 px-2.5 text-[11px] capitalize",
                        severityFilter === s
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {s === "all" ? "All" : s}
                    </Button>
                  ))}
                </div>
                <div className="h-4 w-px bg-border" />
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/50 mr-1">Category</span>
                  {CATEGORY_FILTERS.map(c => (
                    <Button
                      key={c}
                      size="sm"
                      variant="ghost"
                      onClick={() => setCategoryFilter(c)}
                      className={cn(
                        "h-7 px-2.5 text-[11px] capitalize",
                        categoryFilter === c
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {c === "all" ? "All" : c}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Bug list */}
              <div className="space-y-1.5">
                {filteredBugs.map((bug, i) => {
                  const id = `${bug.runId}-${bug.index ?? i}`;
                  const isExpanded = expandedId === id;
                  return (
                    <div
                      key={id}
                      className={cn(
                        "rounded-lg border border-border bg-card overflow-hidden transition-colors",
                        isExpanded && "ring-1 ring-border"
                      )}
                    >
                      {/* Collapsed row */}
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : id)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
                      >
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        }
                        <StatusDot status={SEVERITY_DOT[bug.severity] ?? "stale"} />
                        <span className="text-[13px] font-medium text-foreground truncate flex-1 min-w-0">
                          {bug.name}
                        </span>
                        <Badge variant={CATEGORY_VARIANT[bug.category] ?? "neutral"} className="capitalize flex-shrink-0">
                          {bug.category}
                        </Badge>
                        <Badge variant={STATUS_VARIANT[bug.status] ?? "neutral"} className="capitalize flex-shrink-0">
                          {bug.status.replace("_", " ")}
                        </Badge>
                        <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0">
                          {formatReportedAt(bug.reportedAt)}
                        </span>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/10 animate-fade-in">
                          {bug.description && (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                                Description
                              </p>
                              <p className="text-[13px] text-foreground whitespace-pre-wrap">{bug.description}</p>
                            </div>
                          )}

                          {bug.stepsToReproduce.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
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
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
                                <ImageIcon className="h-3 w-3" />
                                Screenshot
                              </p>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button className="rounded-lg border border-border overflow-hidden hover:ring-1 hover:ring-primary/30 transition-all cursor-zoom-in">
                                    <img
                                      src={`data:image/jpeg;base64,${bug.screenshotBase64}`}
                                      alt="Bug screenshot"
                                      className="max-w-full max-h-[200px] object-contain bg-black/5"
                                    />
                                  </button>
                                </DialogTrigger>
                                <DialogContent className="max-w-3xl">
                                  <DialogHeader>
                                    <DialogTitle>Screenshot</DialogTitle>
                                  </DialogHeader>
                                  <img
                                    src={`data:image/jpeg;base64,${bug.screenshotBase64}`}
                                    alt="Bug screenshot"
                                    className="w-full rounded-lg border border-border object-contain bg-black/5"
                                  />
                                </DialogContent>
                              </Dialog>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
                            {bug.environment && (
                              <span className="flex items-center gap-1">
                                <Server className="h-3.5 w-3.5 flex-shrink-0" />
                                {bug.environment}
                              </span>
                            )}
                            {bug.url && (
                              <a
                                href={bug.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 hover:text-foreground transition-colors font-mono truncate max-w-xs"
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
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[11px] gap-1 ml-auto"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/runs/${bug.runId}`);
                              }}
                            >
                              View Run
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {filteredBugs.length === 0 && (
                <div className="text-center py-8 text-[13px] text-muted-foreground">
                  No issues matching current filters
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
