import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Warning,
  Bug,
  ArrowSquareOut,
  ArrowsClockwise,
  Globe,
  ComputerTower,
  Calendar,
  Trash,
  FilePdf,
  CaretRight,
  CaretDown,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { SHOW_RUN_DEBUG } from "@/lib/debugFlag";
import { formatReportedAt } from "@/lib/formatters";
import { BUG_SEVERITY_STATUS_DOT, BUG_STATUS_BADGE, bugCategoryTagClass, bugStatusLabel, projectBugDetailDescription } from "@/lib/bug-issue-display";
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
import { apiMediaUrl, runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";
import { downloadIssuesPdf } from "@/lib/export-issues-pdf";
import { BugRecordingClip, deriveBugClipRange } from "@/components/bug-recording-clip";
import { fetchRun } from "@/projectApi";

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
  /** Joined from test_runs */
  test_id?: string | null;
  destination_id?: string | null;
  test_name?: string | null;
  environment?: string | null;
  index?: number;
  step_index?: number | null;
};

const SEVERITY_FILTERS = ["all", "high", "medium", "low"] as const;
type SeverityFilter = (typeof SEVERITY_FILTERS)[number];

const CATEGORY_FILTERS = ["all", "visual", "functional", "ux", "other"] as const;
const SOURCE_FILTERS = ["all", "routes", "flows"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_VARIANT: Record<string, "destructive" | "warning" | "neutral"> = {
  high: "destructive",
  medium: "warning",
  low: "neutral",
};


// ─── Issue detail pane ────────────────────────────────────────────────────────

function IssueDetail({
  bug,
  actionBusy,
  showRaw,
  onToggleRaw,
  onResolve,
  onIgnore,
  onDelete,
  onViewRun,
}: {
  bug: BugRecord;
  actionBusy: string | null;
  showRaw: boolean;
  onToggleRaw: () => void;
  onResolve: () => void;
  onIgnore: () => void;
  onDelete: () => void;
  onViewRun: () => void;
}) {
  const detail = projectBugDetailDescription(bug);
  const runKey = bug.run_id ?? bug.runId;
  const fileUrl = runScreenshotFileUrl(runKey, bug.screenshot_path ?? bug.screenshotPath);
  const legacy = screenshotRefToSrc(bug.screenshot_base64 ?? bug.screenshotBase64 ?? undefined);
  const screenshotSrc = fileUrl ?? legacy;
  const reportedDate = bug.reportedAt ?? bug.reported_at;
  const isOpen = bug.status === "open" || bug.status === "in_progress";

  const hasContext = !!(bug.environment || reportedDate || bug.url || bug.category || bug.status || bug.test_name);

  // Lazy-fetch the run to derive recording clip range
  const [runMeta, setRunMeta] = React.useState<{
    video_url?: string | null;
    recording_started_at?: number | null;
    steps_json?: { index?: number; at?: number }[];
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setRunMeta(null);
    if (!runKey) return;
    fetchRun(runKey)
      .then((res: any) => {
        if (cancelled || !res?.run) return;
        setRunMeta({
          video_url: res.run.video_url ?? null,
          recording_started_at: res.run.recording_started_at ?? null,
          steps_json: res.run.steps_json ?? [],
        });
      })
      .catch(() => { /* clip just won't render */ });
    return () => { cancelled = true; };
  }, [runKey]);

  const clipRange = runMeta?.video_url
    ? deriveBugClipRange(runMeta.steps_json ?? [], runMeta.recording_started_at ?? null, bug.step_index ?? null)
    : null;
  const videoUrl = runMeta?.video_url ? apiMediaUrl(runMeta.video_url) : null;

  return (
    <div className="flex flex-col h-full">
      {/* ── Detail header ── */}
      <div className="flex-shrink-0 border-b border-border px-5 py-3 bg-surface-2 dark:bg-surface-3">
        <div className="flex items-center justify-between gap-3">
          {/* Title + tags */}
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <h2 className="text-[15px] font-semibold text-foreground leading-snug truncate min-w-0">{bug.name}</h2>
          </div>
          {/* Actions — uniform outline style */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button size="sm" variant="outline" className="h-7 px-3 text-[11px] gap-1" onClick={onViewRun}>
              View Run <ArrowSquareOut className="h-3 w-3" />
            </Button>
            {bug.id && isOpen && (
              <Button
                size="sm"
                variant="default"
                className="h-7 px-3 text-[11px]"
                disabled={actionBusy === bug.id}
                onClick={onResolve}
              >
                Mark for fix
              </Button>
            )}
            {bug.id && isOpen && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-[11px]"
                disabled={actionBusy === bug.id}
                onClick={onIgnore}
              >
                Ignore
              </Button>
            )}
            {bug.id && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
                disabled={actionBusy === bug.id}
                onClick={onDelete}
              >
                <Trash className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-surface-1 dark:bg-surface-2">
        {/* Screenshot + Recording — hero, full width */}
        {(screenshotSrc || (clipRange && videoUrl)) && (
          <div className="border-b border-border bg-surface-2 dark:bg-surface-3 px-6 py-5">
            <div className={cn(
              "mx-auto grid w-full max-w-4xl gap-4",
              screenshotSrc && clipRange && videoUrl ? "md:grid-cols-2" : "grid-cols-1",
            )}>
              {screenshotSrc && (
                <BugScreenshotZoomDialog
                  src={screenshotSrc}
                  triggerClassName="w-full"
                  thumbnailClassName="w-full max-h-[400px] object-contain"
                />
              )}
              {clipRange && videoUrl && (
                <BugRecordingClip
                  videoUrl={videoUrl}
                  startSec={clipRange.startSec}
                  endSec={clipRange.endSec}
                  posterSrc={screenshotSrc ?? undefined}
                  bugName={bug.name}
                />
              )}
            </div>
          </div>
        )}

        <div className="px-6 py-5 space-y-4">
          {/* Description */}
          {detail && (
            <section>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-2">
                Description
              </p>
              <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{detail}</p>
            </section>
          )}

          {/* Additional info */}
          {hasContext && (
            <section className="border-t border-border pt-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-3">
                Additional info
              </p>
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <BugCategoryTag category={bug.category} />
                  <Badge variant={BUG_STATUS_BADGE[bug.status] ?? "neutral"} className="text-[10px]">
                    {bugStatusLabel(bug.status)}
                  </Badge>
                  {bug.test_name && (
                    <Badge variant="outline" className="text-[10px]">
                      {bug.test_name}
                    </Badge>
                  )}
                </div>
                {bug.environment && (
                  <div className="flex items-center gap-2">
                    <ComputerTower className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0">Environment</span>
                    <span className="text-[12px] text-muted-foreground">{bug.environment}</span>
                  </div>
                )}
                {reportedDate && (
                  <div className="flex items-center gap-2">
                    <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0">Detected</span>
                    <span className="text-[12px] font-mono text-muted-foreground">{new Date(reportedDate).toLocaleString()}</span>
                  </div>
                )}
                {bug.url && (
                  <div className="flex items-start gap-2 min-w-0">
                    <Globe className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 mt-0.5" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0 mt-0.5">URL</span>
                    <a
                      href={bug.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 min-w-0 text-[12px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="truncate">{bug.url}</span>
                      <ArrowSquareOut className="h-3 w-3 flex-shrink-0 opacity-50" aria-hidden="true" />
                    </a>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Raw data toggle */}
          {SHOW_RUN_DEBUG && (
            <section className="border-t border-border pt-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                onClick={onToggleRaw}
              >
                {showRaw ? <CaretDown className="h-3 w-3" /> : <CaretRight className="h-3 w-3" />}
                {showRaw ? "Hide" : "Show"} raw data
              </button>
              {showRaw && (
                <pre className="mt-2 text-[11px] font-mono bg-surface-2 dark:bg-surface-3 rounded-lg border border-border px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-64">
                  {JSON.stringify(bug, null, 2)}
                </pre>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export const Bugs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject } = useProject();
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>("all");
  const [severityFilter, setSeverityFilter] = React.useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<CategoryFilter>("all");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [showRawId, setShowRawId] = React.useState<string | null>(null);
  const [deletePrompt, setDeletePrompt] = React.useState<
    null | { kind: "all" } | { kind: "one"; bug: BugRecord }
  >(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [exportBusy, setExportBusy] = React.useState(false);

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
      setSelectedId(null);
      setDeletePrompt(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  }

  async function markBugForFix(bug: BugRecord) {
    if (!currentProjectId || !bug.id) return;
    setActionBusy(bug.id);
    try {
      await patchProjectBug(currentProjectId, bug.id, { status: "in_progress" });
      await load();
    } finally {
      setActionBusy(null);
    }
  }

  const [bulkBusy, setBulkBusy] = React.useState(false);
  async function markAllForFix(bugsToMark: BugRecord[]) {
    if (!currentProjectId || bugsToMark.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        bugsToMark
          .filter((b) => b.id && b.status === "open")
          .map((b) => patchProjectBug(currentProjectId, b.id!, { status: "in_progress" })),
      );
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  async function ignoreBug(bug: BugRecord) {
    if (!currentProjectId || !bug.id) return;
    setActionBusy(bug.id);
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
    if (severityFilter !== "all") result = result.filter(b => b.severity === severityFilter);
    if (categoryFilter !== "all") result = result.filter(b => b.category === categoryFilter);
    if (sourceFilter === "flows") result = result.filter(b => !!b.test_id);
    else if (sourceFilter === "routes") result = result.filter(b => !!b.destination_id && !b.test_id);
    result.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
    return result;
  }, [bugs, severityFilter, categoryFilter, sourceFilter]);

  React.useEffect(() => {
    if (filteredBugs.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !filteredBugs.some((b, i) => (b.id ?? `${b.run_id ?? b.runId}-${b.index ?? i}`) === selectedId)) {
      const first = filteredBugs[0];
      setSelectedId(first.id ?? `${first.run_id ?? first.runId}-${first.index ?? 0}`);
    }
  }, [filteredBugs, selectedId]);

  const selectedBug = React.useMemo(() => {
    if (!selectedId) return null;
    return filteredBugs.find((b, i) => (b.id ?? `${b.run_id ?? b.runId}-${b.index ?? i}`) === selectedId) ?? null;
  }, [filteredBugs, selectedId]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Bug className="h-4 w-4" />} title="Issues" />
        <EmptyState
          icon={<Bug className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view issues."
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full">
      {/* ── Top bar ── */}
      <PageHeader icon={<Bug className="h-4 w-4" />} title="Issues">
        {!loading && bugs.length > 0 && (
          <Badge variant="neutral" className="font-mono">{bugs.length}</Badge>
        )}
        {!loading && bugs.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFiltersOpen((v) => !v)}
            className="gap-1.5"
          >
            Filters
            {filtersOpen ? <CaretDown className="h-3.5 w-3.5" /> : <CaretRight className="h-3.5 w-3.5" />}
          </Button>
        )}
        {!loading && bugs.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={exportBusy}
            onClick={() => {
              setExportBusy(true);
              downloadIssuesPdf({ projectName: currentProject?.name, issues: bugs })
                .then(() => toast.success("Exported issues as PDF"))
                .catch(() => toast.error("Could not export PDF"))
                .finally(() => setExportBusy(false));
            }}
          >
            <FilePdf className="h-3.5 w-3.5" />
            {exportBusy ? "Exporting…" : "Export PDF"}
          </Button>
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

      {/* ── Expandable filters (only when there are bugs) ── */}
      {!loading && bugs.length > 0 && filtersOpen && (
        <div className="flex-shrink-0 border-b border-border bg-surface-2 dark:bg-surface-3 px-5 py-2.5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55">Source</label>
              <Select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
                className="w-[120px] h-8 text-[12px]"
              >
                {SOURCE_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All" : s === "routes" ? "Routes" : "Flows"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55">Severity</label>
              <Select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
                className="w-[130px] h-8 text-[12px]"
              >
                {SEVERITY_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55">Category</label>
              <Select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
                className="w-[140px] h-8 text-[12px]"
              >
                {CATEGORY_FILTERS.map((c) => (
                  <option key={c} value={c}>
                    {c === "all" ? "All" : c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      {loading ? (
        <div className="px-6 py-5 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : bugs.length === 0 ? (
        <EmptyState
          icon={<Warning className="h-8 w-8" />}
          title="No issues yet"
          description="Issues are reported by the agent during test runs. Run a test to start finding problems."
          action={{ label: "Go to Flows", onClick: () => navigate("/tests") }}
          className="flex-1"
        />
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ── Left: issue list ── */}
          <div className="w-[340px] flex-shrink-0 flex flex-col min-h-0 border-r border-border overflow-hidden">
            {/* list header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0 bg-surface-2 dark:bg-surface-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Issues
              </span>
              <span className="text-[11px] font-mono text-muted-foreground/60">
                {filteredBugs.length < bugs.length
                  ? `${filteredBugs.length} / ${bugs.length}`
                  : bugs.length}
              </span>
            </div>

            {/* Triage banner — only when there are untriaged bugs in current filter */}
            {(() => {
              const untriaged = filteredBugs.filter((b) => b.status === "open");
              if (untriaged.length === 0) return null;
              return (
                <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-2 flex-shrink-0">
                  <span className="text-[11px] text-foreground flex-1 min-w-0">
                    <span className="font-medium">{untriaged.length}</span> bug{untriaged.length === 1 ? "" : "s"} need review
                  </span>
                  <button
                    type="button"
                    className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={bulkBusy}
                    onClick={() => markAllForFix(untriaged)}
                  >
                    Mark all for fix
                  </button>
                </div>
              );
            })()}

            {/* scrollable list */}
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
              {filteredBugs.length === 0 ? (
                <p className="text-center py-8 text-[12px] text-muted-foreground">
                  No issues match current filters
                </p>
              ) : (
                filteredBugs.map((bug, i) => {
                  const id = bug.id ?? `${bug.run_id ?? bug.runId}-${bug.index ?? i}`;
                  const selected = id === selectedId;
                  const reportedIso = bug.reportedAt ?? bug.reported_at ?? "";
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelectedId(id)}
                      className="w-full text-left block"
                    >
                      <Card
                        className={cn(
                          "w-full transition-all",
                          selected && "ring-2 ring-ring/20 border-border bg-accent/25",
                        )}
                      >
                        <CardContent className="py-2.5 px-3.5">
                          <div className="flex items-start gap-2.5">
                            <StatusDot
                              status={BUG_SEVERITY_STATUS_DOT[bug.severity] ?? "stale"}
                              className="mt-0.5 flex-shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] font-medium text-foreground truncate">
                                {bug.name}
                              </p>
                              {bug.description && (
                                <p className="text-[12px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                                  {bug.description}
                                </p>
                              )}
                              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                <BugCategoryTag category={bug.category} />
                                <Badge
                                  variant={BUG_STATUS_BADGE[bug.status] ?? "neutral"}
                                  className="text-[10px]"
                                >
                                  {bugStatusLabel(bug.status)}
                                </Badge>
                                <span className="ml-auto text-[10px] font-mono text-muted-foreground/50">
                                  {formatReportedAt(reportedIso)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Right: detail pane ── */}
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
            {!selectedBug ? (
              <EmptyState
                icon={<Warning className="h-6 w-6" />}
                title="Select an issue"
                description="Pick an issue from the list to inspect details."
                className="flex-1"
              />
            ) : (
              <IssueDetail
                key={selectedBug.id ?? selectedId}
                bug={selectedBug}
                actionBusy={actionBusy}
                showRaw={showRawId === selectedId}
                onToggleRaw={() => setShowRawId(showRawId === selectedId ? null : selectedId)}
                onResolve={() => markBugForFix(selectedBug)}
                onIgnore={() => ignoreBug(selectedBug)}
                onDelete={() => setDeletePrompt({ kind: "one", bug: selectedBug })}
                onViewRun={() => navigate(`/runs/${selectedBug.run_id ?? selectedBug.runId}`)}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Delete confirm dialog ── */}
      <Dialog
        open={deletePrompt !== null}
        onOpenChange={(o) => { if (!o && !deleteBusy) setDeletePrompt(null); }}
      >
        <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete issue{deletePrompt?.kind === "all" ? "s" : ""}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {deletePrompt?.kind === "all" && (
                <>Permanently delete all <strong>{bugs.length}</strong> issues? This cannot be undone.</>
              )}
              {deletePrompt?.kind === "one" && (
                <>Permanently delete &ldquo;{deletePrompt.bug.name}&rdquo;? This cannot be undone.</>
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
