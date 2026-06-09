import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Warning,
  Bug,
  ArrowSquareOut,
  ArrowsClockwise,
  Globe,
  Trash,
  FilePdf,
  CaretRight,
  CaretDown,
  X,
  Info,
  ArrowRight,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SHOW_RUN_DEBUG } from "@/lib/debugFlag";
import { formatReportedAt } from "@/lib/formatters";
import { projectBugDetailDescription } from "@/lib/bug-issue-display";
import { BugScreenshotZoomDialog } from "@/components/bug-screenshot-zoom-dialog";
import { useProject } from "@/lib/projectContext";
import {
  fetchProjectBugs, patchProjectBug, createMemoryEntry,
  deleteProjectBug, deleteAllProjectBugs, fetchRun,
} from "@/projectApi";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { apiMediaUrl, runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";
import { downloadIssuesPdf } from "@/lib/export-issues-pdf";
import { BugRecordingClip, deriveBugClipRange } from "@/components/bug-recording-clip";

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
  reported_at?: string;
  test_id?: string | null;
  destination_id?: string | null;
  test_name?: string | null;
  environment?: string | null;
  index?: number;
  step_index?: number | null;
};

type BugStatus = "open" | "in_progress" | "wont_fix";

const COLUMNS: { key: BugStatus; label: string }[] = [
  { key: "open",        label: "Open"    },
  { key: "in_progress", label: "To Fix"  },
  { key: "wont_fix",    label: "Ignored" },
];

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ─── Chips ────────────────────────────────────────────────────────────────────

const SEVERITY_CHIP: Record<string, string> = {
  high:   "bg-destructive/10 text-destructive border-destructive/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low:    "bg-muted text-muted-foreground border-border",
};

const CATEGORY_CHIP: Record<string, string> = {
  visual:     "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  functional: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  ux:         "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  other:      "bg-muted text-muted-foreground border-border",
};

function SeverityChip({ severity }: { severity: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      SEVERITY_CHIP[severity] ?? "bg-muted text-muted-foreground border-border",
    )}>
      {severity}
    </span>
  );
}

function CategoryChip({ category }: { category: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
      CATEGORY_CHIP[category] ?? "bg-muted text-muted-foreground border-border",
    )}>
      {category}
    </span>
  );
}

// ─── Kanban Card ──────────────────────────────────────────────────────────────

function KanbanCard({
  bug,
  busy,
  onClick,
  onDragStart,
}: {
  bug: BugRecord;
  busy: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const reportedIso = bug.reportedAt ?? bug.reported_at ?? "";
  return (
    <div
      draggable={!busy && !!bug.id}
      onDragStart={onDragStart}
      onClick={onClick}
      className={cn(
        "bg-card border border-border rounded-lg p-3 cursor-pointer select-none",
        "hover:border-primary/30 transition-all",
        busy && "opacity-50 pointer-events-none",
      )}
    >
      <p className="text-[13px] font-medium text-foreground leading-snug mb-1.5">{bug.name}</p>
      {bug.description && (
        <p className="text-[12px] text-muted-foreground line-clamp-2 leading-relaxed mb-2">
          {bug.description}
        </p>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <SeverityChip severity={bug.severity} />
        <CategoryChip category={bug.category} />
        <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
          {formatReportedAt(reportedIso)}
        </span>
      </div>
    </div>
  );
}

// ─── Kanban Column ────────────────────────────────────────────────────────────

function KanbanColumn({
  label,
  status,
  bugs,
  actionBusy,
  onCardClick,
  onDragStart,
  onDrop,
  headerSlot,
}: {
  label: string;
  status: BugStatus;
  bugs: BugRecord[];
  actionBusy: string | null;
  onCardClick: (bug: BugRecord) => void;
  onDragStart: (bug: BugRecord, e: React.DragEvent) => void;
  onDrop: (status: BugStatus) => void;
  headerSlot?: React.ReactNode;
}) {
  const [dragOver, setDragOver] = React.useState(false);

  const EMPTY_TEXT: Record<BugStatus, string> = {
    open:        "No open issues",
    in_progress: "Nothing queued to fix",
    wont_fix:    "No ignored issues",
  };

  return (
    <div className="flex-1 min-w-[240px] flex flex-col min-h-0 border-r border-border last:border-r-0">
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border bg-surface-2 dark:bg-surface-3">
        <span className="text-[12px] font-semibold text-foreground">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground/60 bg-muted px-1.5 py-0.5 rounded-full leading-none">
          {bugs.length}
        </span>
        {headerSlot}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onDrop(status); }}
        className={cn(
          "flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2 transition-colors",
          dragOver && "bg-primary/5 ring-2 ring-inset ring-primary/20",
        )}
      >
        {bugs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground/40 text-center py-10">{EMPTY_TEXT[status]}</p>
        ) : (
          bugs.map((bug, i) => (
            <KanbanCard
              key={bug.id ?? `${bug.run_id ?? bug.runId}-${i}`}
              bug={bug}
              busy={actionBusy === bug.id}
              onClick={() => onCardClick(bug)}
              onDragStart={(e) => onDragStart(bug, e)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Issue Detail Dialog ──────────────────────────────────────────────────────

function IssueDetailDialog({
  bug,
  open,
  onOpenChange,
  actionBusy,
  onMoveTo,
  onDelete,
  onViewRun,
}: {
  bug: BugRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionBusy: string | null;
  onMoveTo: (status: BugStatus) => void;
  onDelete: () => void;
  onViewRun: () => void;
}) {
  const [showRaw, setShowRaw] = React.useState(false);
  React.useEffect(() => { setShowRaw(false); }, [bug?.id]);

  const runKey = bug ? (bug.run_id ?? bug.runId) : null;
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
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runKey]);

  if (!bug) return null;

  const fileUrl = runScreenshotFileUrl(runKey ?? "", bug.screenshot_path ?? bug.screenshotPath);
  const legacy = screenshotRefToSrc(bug.screenshot_base64 ?? bug.screenshotBase64 ?? undefined);
  const screenshotSrc = fileUrl ?? legacy;
  const clipRange = runMeta?.video_url
    ? deriveBugClipRange(runMeta.steps_json ?? [], runMeta.recording_started_at ?? null, bug.step_index ?? null)
    : null;
  const videoUrl = runMeta?.video_url ? apiMediaUrl(runMeta.video_url) : null;
  const detail = projectBugDetailDescription(bug);
  const reportedDate = bug.reportedAt ?? bug.reported_at;
  const isBusy = actionBusy === bug.id;
  const currentStatus = bug.status as BugStatus;
  const moveTargets = COLUMNS.filter(c => c.key !== currentStatus);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-full p-0 gap-0 overflow-hidden flex flex-col" style={{ maxHeight: "90vh" }}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <h2 className="text-[16px] font-semibold text-foreground leading-snug">{bug.name}</h2>
              <div className="flex items-center gap-1.5 flex-wrap">
                <SeverityChip severity={bug.severity} />
                <CategoryChip category={bug.category} />
                {reportedDate && (
                  <span className="text-[11px] font-mono text-muted-foreground/50">
                    {formatReportedAt(reportedDate)}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex-shrink-0 -mt-0.5 p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(screenshotSrc || (clipRange && videoUrl)) && (
            <div className="border-b border-border bg-surface-2 dark:bg-surface-3 px-6 py-4">
              <div className={cn(
                "mx-auto grid w-full gap-4",
                screenshotSrc && clipRange && videoUrl ? "md:grid-cols-2" : "grid-cols-1",
              )}>
                {screenshotSrc && (
                  <BugScreenshotZoomDialog
                    src={screenshotSrc}
                    triggerClassName="w-full"
                    thumbnailClassName="w-full max-h-[280px] object-contain"
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
            {detail && (
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-2">
                  Description
                </p>
                <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{detail}</p>
              </section>
            )}

            {bug.url && (
              <section className="border-t border-border pt-4">
                <div className="flex items-start gap-2 min-w-0">
                  <Globe className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 mt-0.5" />
                  <a
                    href={bug.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 min-w-0 text-[12px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span className="truncate">{bug.url}</span>
                    <ArrowSquareOut className="h-3 w-3 flex-shrink-0 opacity-50" />
                  </a>
                </div>
              </section>
            )}

            {SHOW_RUN_DEBUG && (
              <section className="border-t border-border pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                  onClick={() => setShowRaw(v => !v)}
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

        {/* Footer */}
        <div className="flex-shrink-0 border-t border-border px-6 py-3 flex items-center gap-2 bg-surface-2 dark:bg-surface-3 flex-wrap">
          <Button size="sm" variant="outline" onClick={onViewRun} className="gap-1 h-7 text-[12px]">
            View run <ArrowSquareOut className="h-3 w-3" />
          </Button>
          <div className="flex-1" />
          {moveTargets.map(target => (
            <Button
              key={target.key}
              size="sm"
              variant={target.key === "in_progress" ? "default" : "outline"}
              disabled={isBusy}
              onClick={() => onMoveTo(target.key)}
              className="gap-1 h-7 text-[12px]"
            >
              <ArrowRight className="h-3 w-3" />
              {target.label}
            </Button>
          ))}
          {bug.id && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0 text-destructive border-destructive/30 hover:bg-destructive/10"
              disabled={isBusy}
              onClick={onDelete}
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export const Bugs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject } = useProject();
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [detailBug, setDetailBug] = React.useState<BugRecord | null>(null);
  const [deletePrompt, setDeletePrompt] = React.useState<
    null | { kind: "all" } | { kind: "one"; bug: BugRecord }
  >(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [exportBusy, setExportBusy] = React.useState(false);
  const [draggedId, setDraggedId] = React.useState<string | null>(null);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] }));
    setBugs(res.bugs ?? []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  async function moveBug(bug: BugRecord, newStatus: BugStatus) {
    if (!currentProjectId || !bug.id || bug.status === newStatus) return;
    setActionBusy(bug.id);
    try {
      await patchProjectBug(currentProjectId, bug.id, { status: newStatus });
      if (newStatus === "wont_fix") {
        await createMemoryEntry(currentProjectId, {
          type: "ignore_region",
          summary: `Ignored issue: ${bug.name}`,
          content: `${bug.description}\n\n${bug.url ? `URL: ${bug.url}` : ""}`.trim(),
          confidence: 100,
        });
      }
      setBugs(prev => prev.map(b => b.id === bug.id ? { ...b, status: newStatus } : b));
      setDetailBug(prev => (prev?.id === bug.id && prev) ? { ...prev, status: newStatus } : prev);
    } finally {
      setActionBusy(null);
    }
  }

  async function bulkMove(toStatus: BugStatus) {
    if (!currentProjectId) return;
    const targets = bugs.filter(b => b.id && b.status === "open");
    if (!targets.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(targets.map(b => patchProjectBug(currentProjectId, b.id!, { status: toStatus })));
      if (toStatus === "wont_fix") {
        await Promise.all(targets.map(b => createMemoryEntry(currentProjectId, {
          type: "ignore_region",
          summary: `Ignored issue: ${b.name}`,
          content: `${b.description}\n\n${b.url ? `URL: ${b.url}` : ""}`.trim(),
          confidence: 100,
        })));
      }
      setBugs(prev => prev.map(b => b.status === "open" && b.id ? { ...b, status: toStatus } : b));
    } finally {
      setBulkBusy(false);
    }
  }

  function handleDrop(targetStatus: BugStatus) {
    if (!draggedId) return;
    const bug = bugs.find(b => b.id === draggedId);
    setDraggedId(null);
    if (!bug || (bug.status as BugStatus) === targetStatus) return;
    moveBug(bug, targetStatus);
  }

  async function executeDelete() {
    if (!currentProjectId || !deletePrompt) return;
    setDeleteBusy(true);
    try {
      if (deletePrompt.kind === "all") {
        await deleteAllProjectBugs(currentProjectId);
        setBugs([]);
        setDetailBug(null);
      } else if (deletePrompt.bug.id) {
        await deleteProjectBug(currentProjectId, deletePrompt.bug.id);
        setBugs(prev => prev.filter(b => b.id !== deletePrompt.bug.id));
        if (detailBug?.id === deletePrompt.bug.id) setDetailBug(null);
      }
      setDeletePrompt(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  const columns = COLUMNS.map(col => ({
    ...col,
    bugs: bugs
      .filter(b => b.status === col.key)
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)),
  }));

  const openCount = columns.find(c => c.key === "open")?.bugs.length ?? 0;

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
      <PageHeader icon={<Bug className="h-4 w-4" />} title="Issues">
        {!loading && bugs.length > 0 && (
          <Badge variant="neutral" className="font-mono">{bugs.length}</Badge>
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

      {loading ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {COLUMNS.map(col => (
            <div key={col.key} className="flex-1 min-w-[240px] border-r border-border last:border-r-0 px-3 py-3 space-y-2">
              <Skeleton className="h-5 w-20 mb-4" />
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
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
        <div className="flex flex-1 min-h-0 overflow-x-auto">
          <div className="flex h-full min-w-[720px] w-full">
            {columns.map(col => (
              <KanbanColumn
                key={col.key}
                label={col.label}
                status={col.key}
                bugs={col.bugs}
                actionBusy={actionBusy}
                onCardClick={setDetailBug}
                onDragStart={(bug, e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDraggedId(bug.id ?? null);
                }}
                onDrop={handleDrop}
                headerSlot={
                  col.key === "open" && openCount > 0 ? (
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => bulkMove("in_progress")}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        All → To Fix
                      </button>
                      <span className="text-muted-foreground/30 text-[10px]">·</span>
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => bulkMove("wont_fix")}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        All → Ignored
                      </button>
                    </div>
                  ) : col.key === "in_progress" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-auto cursor-help text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                          <Info className="h-3.5 w-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[220px] text-[12px] leading-relaxed">
                        Connect your editor via MCP and ask your agent to "fix issues from Kery" to resolve these automatically.
                      </TooltipContent>
                    </Tooltip>
                  ) : null
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Issue detail dialog */}
      <IssueDetailDialog
        bug={detailBug}
        open={detailBug !== null}
        onOpenChange={(o) => { if (!o) setDetailBug(null); }}
        actionBusy={actionBusy}
        onMoveTo={(status) => { if (detailBug) moveBug(detailBug, status); }}
        onDelete={() => { if (detailBug) setDeletePrompt({ kind: "one", bug: detailBug }); }}
        onViewRun={() => {
          if (detailBug) navigate(`/runs/${detailBug.run_id ?? detailBug.runId}`);
          setDetailBug(null);
        }}
      />

      {/* Delete confirm dialog */}
      <Dialog
        open={deletePrompt !== null}
        onOpenChange={(o) => { if (!o && !deleteBusy) setDeletePrompt(null); }}
      >
        <DialogContent className="max-w-md">
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
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={deleteBusy} onClick={() => setDeletePrompt(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={deleteBusy} onClick={executeDelete}>
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
