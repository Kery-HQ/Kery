import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Warning,
  CaretDown,
  CaretRight,
  ArrowSquareOut,
  ArrowsClockwise,
  Globe,
  Image as ImageIcon,
  ComputerTower,
  Calendar,
  Trash,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatReportedAt } from "@/lib/formatters";
import { BUG_SEVERITY_STATUS_DOT, bugCategoryTagClass, projectBugDetailDescription } from "@/lib/bug-issue-display";
import { BugCategoryTag } from "@/components/bug-category-tag";
import { BugScreenshotZoomDialog } from "@/components/bug-screenshot-zoom-dialog";
import { useProject } from "@/lib/projectContext";
import {
  fetchProjectBugs,
  patchProjectBug,
  createMemoryEntry,
  deleteProjectBug,
  deleteAllProjectBugs,
} from "@/projectApi";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";

export type BugRecord = {
  id?: string;
  name: string;
  description: string;
  category: "visual" | "functional" | "ux" | "other";
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  screenshotPath?: string | null;
  screenshot_path?: string | null;
  screenshotBase64?: string | null;
  screenshot_base64?: string | null;
  run_id?: string;
  url?: string | null;
  runId: string;
  runLabel?: string | null;
  reportedAt?: string;
  /** API returns snake_case from DB rows */
  reported_at?: string;
  environment?: string | null;
  index?: number;
};

const SEVERITY_FILTERS = ["all", "high", "medium", "low"] as const;
type SeverityFilter = (typeof SEVERITY_FILTERS)[number];

const CATEGORY_FILTERS = ["all", "visual", "functional", "ux", "other"] as const;
type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

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

export const Bugs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = React.useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<CategoryFilter>("all");
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [showRawId, setShowRawId] = React.useState<string | null>(null);
  const [deletePrompt, setDeletePrompt] = React.useState<
    null | { kind: "all" } | { kind: "one"; bug: BugRecord }
  >(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] }));
    setBugs(res.bugs ?? []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  async function executeDelete() {
    if (!currentProjectId || !deletePrompt) return;
    setDeleteBusy(true);
    try {
      if (deletePrompt.kind === "all") {
        await deleteAllProjectBugs(currentProjectId);
      } else if (deletePrompt.bug.id) {
        await deleteProjectBug(currentProjectId, deletePrompt.bug.id);
      }
      setExpandedId(null);
      setDeletePrompt(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  }

  async function resolveBug(bug: BugRecord) {
    if (!currentProjectId || !bug.id) return;
    const key = bug.id;
    setActionBusy(key);
    try {
      await patchProjectBug(currentProjectId, bug.id, { status: "resolved" });
      await load();
    } finally {
      setActionBusy(null);
    }
  }

  async function ignoreBug(bug: BugRecord) {
    if (!currentProjectId || !bug.id) return;
    const key = bug.id;
    setActionBusy(key);
    try {
      await patchProjectBug(currentProjectId, bug.id, { status: "wont_fix" });
      await createMemoryEntry(currentProjectId, {
        type: "ignore_region",
        summary: `Ignored issue: ${bug.name}`,
        content: `${bug.description}\n\n${bug.url ? `URL: ${bug.url}` : ""}`.trim(),
        confidence: 100,
      });
      await load();
    } finally {
      setActionBusy(null);
    }
  }

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
        <PageHeader icon={<Warning className="h-4 w-4" />} title="Issues" />
        <EmptyState
          icon={<Warning className="h-8 w-8" />}
          title="No project selected"
          description="Create or select a project to view issues."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Warning className="h-4 w-4" />} title="Issues">
        {!loading && bugs.length > 0 && (
          <Badge variant="neutral" className="font-mono">{bugs.length}</Badge>
        )}
        {!loading && bugs.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => setDeletePrompt({ kind: "all" })}
          >
            <Trash className="h-3.5 w-3.5" />
            Delete all
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={load}>
          <ArrowsClockwise className="h-3.5 w-3.5" />
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
              icon={<Warning className="h-8 w-8" />}
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
                          ? c === "all"
                            ? "bg-accent text-foreground"
                            : cn("bg-accent font-medium", bugCategoryTagClass(c))
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
                  const id = bug.id ?? `${bug.run_id ?? bug.runId}-${bug.index ?? i}`;
                  const isExpanded = expandedId === id;
                  const reportedIso = bug.reportedAt ?? bug.reported_at ?? "";
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
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors min-w-0"
                      >
                        {isExpanded
                          ? <CaretDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          : <CaretRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        }
                        <StatusDot status={BUG_SEVERITY_STATUS_DOT[bug.severity] ?? "stale"} />
                        <span className="text-[13px] font-medium text-foreground truncate flex-1 min-w-0">
                          {bug.name}
                        </span>
                        <BugCategoryTag category={bug.category} />
                        <Badge variant={STATUS_VARIANT[bug.status] ?? "neutral"} className="capitalize flex-shrink-0">
                          {bug.status.replace("_", " ")}
                        </Badge>
                        <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0">
                          {formatReportedAt(reportedIso)}
                        </span>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/10 animate-fade-in">
                          {(() => {
                            const detail = projectBugDetailDescription(bug);
                            if (!detail) return null;
                            return (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                                  Description
                                </p>
                                <p className="text-[13px] text-foreground whitespace-pre-wrap">{detail}</p>
                              </div>
                            );
                          })()}

                          {(() => {
                            const runKey = bug.run_id ?? bug.runId;
                            const fileUrl = runScreenshotFileUrl(runKey, bug.screenshot_path ?? bug.screenshotPath);
                            const legacy = screenshotRefToSrc(
                              bug.screenshot_base64 ?? bug.screenshotBase64 ?? undefined,
                            );
                            const src = fileUrl ?? legacy;
                            if (!src) return null;
                            return (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
                                  <ImageIcon className="h-3 w-3" />
                                  Screenshot
                                </p>
                                <BugScreenshotZoomDialog src={src} />
                              </div>
                            );
                          })()}

                          <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
                            {bug.environment && (
                              <span className="flex items-center gap-1">
                                <ComputerTower className="h-3.5 w-3.5 flex-shrink-0" />
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
                                <ArrowSquareOut className="h-3 w-3 flex-shrink-0" />
                              </a>
                            )}
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3.5 w-3.5" />
                              {reportedIso ? new Date(reportedIso).toLocaleString() : "—"}
                            </span>
                            <div className="flex flex-wrap items-center gap-2 ml-auto">
                              {bug.id && (bug.status === "open" || bug.status === "in_progress") && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[11px]"
                                    disabled={actionBusy === bug.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      resolveBug(bug);
                                    }}
                                  >
                                    Resolve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-[11px]"
                                    disabled={actionBusy === bug.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      ignoreBug(bug);
                                    }}
                                  >
                                    Ignore
                                  </Button>
                                </>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-[11px] gap-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/runs/${bug.run_id ?? bug.runId}`);
                                }}
                              >
                                View Run
                                <ArrowSquareOut className="h-3 w-3" />
                              </Button>
                              {bug.id && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
                                  disabled={actionBusy === bug.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletePrompt({ kind: "one", bug });
                                  }}
                                >
                                  <Trash className="h-3 w-3" />
                                  Delete
                                </Button>
                              )}
                            </div>
                          </div>

                          <div className="border-t border-border pt-3">
                            <button
                              type="button"
                              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 hover:text-foreground/70"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowRawId(showRawId === id ? null : id);
                              }}
                            >
                              Show raw data {showRawId === id ? "▼" : "▶"}
                            </button>
                            {showRawId === id && (
                              <pre className="mt-2 text-[11px] font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-48">
                                {JSON.stringify(bug, null, 2)}
                              </pre>
                            )}
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

      <Dialog
        open={deletePrompt !== null}
        onOpenChange={(o) => {
          if (!o && !deleteBusy) setDeletePrompt(null);
        }}
      >
        <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete issues</DialogTitle>
            <DialogDescription className="text-[13px]">
              {deletePrompt?.kind === "all" && (
                <>
                  Permanently delete all <strong>{bugs.length}</strong> issues for this project? This cannot be undone.
                </>
              )}
              {deletePrompt?.kind === "one" && (
                <>
                  Permanently delete &ldquo;{deletePrompt.bug.name}&rdquo;? This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleteBusy}
              onClick={() => setDeletePrompt(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteBusy}
              onClick={() => executeDelete()}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
