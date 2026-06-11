import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Play,
  Pencil,
  Warning,
  CaretDown,
  CaretRight,
  Globe,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status-dot";
import { BugCategoryTag } from "@/components/bug-category-tag";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";
import { RunList } from "@/components/RunList";
import { useProject } from "@/lib/projectContext";
import { relativeTime } from "@/lib/formatters";
import { toast } from "sonner";
import {
  fetchTests,
  fetchEnvironments,
  fetchProjectRuns,
  fetchProjectBugs,
  runProjectTest,
  updateTest,
  patchProjectBug,
} from "@/projectApi";
import { BUG_SEVERITY_STATUS_DOT, BUG_STATUS_BADGE, bugStatusLabel } from "@/lib/bug-issue-display";
import { runScreenshotFileUrl } from "@/lib/apiAssets";
import { BugScreenshotZoomDialog } from "@/components/bug-screenshot-zoom-dialog";
import type { BugRecord } from "@/pages/Bugs";

type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  max_steps?: number | null;
  created_at: string;
};

const DEFAULT_FLOW_MAX_STEPS = 50;

const SEVERITY_CHIP_FD: Record<string, string> = {
  high:   "bg-destructive/10 text-destructive border-destructive/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low:    "bg-muted text-muted-foreground border-border",
};
const CATEGORY_CHIP_FD: Record<string, string> = {
  visual:     "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  functional: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  ux:         "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  other:      "bg-muted text-muted-foreground border-border",
};
function FlowSeverityChip({ severity }: { severity: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", SEVERITY_CHIP_FD[severity] ?? "bg-muted text-muted-foreground border-border")}>
      {severity}
    </span>
  );
}
function FlowCategoryChip({ category }: { category: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize", CATEGORY_CHIP_FD[category] ?? "bg-muted text-muted-foreground border-border")}>
      {category}
    </span>
  );
}

export function FlowDetail() {
  const { testId } = useParams<{ testId: string }>();
  const navigate = useNavigate();
  const { currentProjectId } = useProject();

  const [test, setTest] = React.useState<SavedTest | null>(null);
  const [runs, setRuns] = React.useState<any[]>([]);
  const [bugs, setBugs] = React.useState<BugRecord[]>([]);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedBugIndex, setSelectedBugIndex] = React.useState(0);
  const [bugActionBusy, setBugActionBusy] = React.useState<string | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [formName, setFormName] = React.useState("");
  const [formIntent, setFormIntent] = React.useState("");
  const [formContext, setFormContext] = React.useState("");
  const [formMaxSteps, setFormMaxSteps] = React.useState("");
  const [formSaving, setFormSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!currentProjectId || !testId) return;
    setLoading(true);
    setError(null);
    try {
      const [testsRes, runsRes, envsRes, bugsRes] = await Promise.all([
        fetchTests(currentProjectId),
        fetchProjectRuns(currentProjectId),
        fetchEnvironments(currentProjectId),
        fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] })),
      ]);
      const found: SavedTest | undefined = (testsRes.tests ?? []).find(
        (t: SavedTest) => t.id === testId,
      );
      if (!found) {
        setError("Flow not found");
        setLoading(false);
        return;
      }
      setTest(found);
      setRuns((runsRes.runs ?? []).filter((r: any) => r.test_id === testId));
      setEnvironments((envsRes as any).environments ?? []);
      setBugs(((bugsRes as any).bugs ?? []).filter((b: BugRecord) => b.test_id === testId));
    } catch (e: any) {
      setError(e?.message || "Failed to load flow");
    }
    setLoading(false);
  }, [currentProjectId, testId]);

  React.useEffect(() => { load(); }, [load]);

  const defaultEnv = environments.find((e: any) => e.is_default) || environments[0];
  const defaultEnvId: string | null = defaultEnv?.id ?? null;

  function openEdit() {
    if (!test) return;
    setFormName(test.name);
    setFormIntent(test.intent);
    setFormContext(test.context ?? "");
    setFormMaxSteps(test.max_steps != null ? String(test.max_steps) : "");
    setEditOpen(true);
  }

  async function handleSaveEdit() {
    if (!currentProjectId || !test || !formName.trim() || !formIntent.trim()) return;
    setFormSaving(true);
    const parsedMaxSteps =
      formMaxSteps.trim() !== ""
        ? Math.min(Math.max(1, parseInt(formMaxSteps, 10)), 250)
        : undefined;
    try {
      const res = await updateTest(currentProjectId, test.id, {
        name: formName.trim(),
        intent: formIntent.trim(),
        context: formContext.trim() || undefined,
        max_steps: parsedMaxSteps ?? null,
      });
      setTest(res.test as SavedTest);
      setEditOpen(false);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleRun() {
    if (!test || !defaultEnvId) return;
    setRunning(true);
    try {
      await runProjectTest(test.project_id, defaultEnvId, "", test.id);
      toast.success("Run queued");
    } catch {}
    setRunning(false);
  }

  if (loading) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-border bg-surface-2 dark:bg-surface-3 flex-shrink-0">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-40" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-14" />
        </div>
        <div className="px-6 py-5 space-y-4 animate-fade-in">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (error || !test) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-border bg-surface-2 dark:bg-surface-3 flex-shrink-0">
          <button
            onClick={() => navigate("/tests")}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Flows
          </button>
        </div>
        <div className="px-6 py-5">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-foreground">
            {error || "Flow not found"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 h-12 border-b border-border bg-surface-2 dark:bg-surface-3 flex-shrink-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/tests")}
            className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Flows
          </button>
          <span className="select-none text-muted-foreground/35 text-[14px]" aria-hidden>/</span>
          <h1
            className="min-w-0 truncate font-display font-semibold text-[14px] tracking-tight text-foreground"
            title={test.name}
          >
            {test.name}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={openEdit}
            className="h-8 gap-1.5 text-[12px]"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={!defaultEnvId}
            loading={running}
            className="h-8 gap-1.5 text-[12px]"
          >
            {!running && <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </div>
      </div>

      {/* Tabbed content */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="animate-fade-in flex flex-col flex-1 min-h-0">
          <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0">
            <TabsList className="pl-6">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="issues">
                Issues
                {bugs.filter(b => b.status === "open" || b.status === "in_progress").length > 0 && (
                  <span className="ml-1.5 rounded-full bg-status-fail/20 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-status-fail">
                    {bugs.filter(b => b.status === "open" || b.status === "in_progress").length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview" className="px-6 py-4 overflow-y-auto">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Main — intent + context */}
                <div className="lg:col-span-2 space-y-3">
                  <div className="rounded-lg border border-border bg-surface-2 dark:bg-surface-3 p-4 space-y-1">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Description</p>
                    <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{test.intent}</p>
                  </div>
                  {test.context ? (
                    <div className="rounded-lg border border-border bg-surface-2 dark:bg-surface-3 p-4 space-y-1">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Context</p>
                      <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{test.context}</p>
                    </div>
                  ) : null}
                </div>

                {/* Sidebar — metadata */}
                <div className="space-y-px rounded-lg border border-border bg-surface-2 dark:bg-surface-3 overflow-hidden">
                  <div className="px-4 py-3 border-b border-border last:border-0">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Max steps</p>
                    <p className="text-[13px] text-foreground tabular-nums">
                      {test.max_steps ?? DEFAULT_FLOW_MAX_STEPS}
                      {test.max_steps == null && (
                        <span className="text-muted-foreground/50"> (default)</span>
                      )}
                    </p>
                  </div>
                  <div className="px-4 py-3 border-b border-border last:border-0">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Open issues</p>
                    <p className="text-[13px] text-foreground">
                      {bugs.filter(b => b.status === "open" || b.status === "in_progress").length || (
                        <span className="text-muted-foreground/50">None</span>
                      )}
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Created</p>
                    <p className="text-[13px] font-mono text-muted-foreground">{relativeTime(test.created_at)}</p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Issues */}
            <TabsContent value="issues" className="mt-0 flex-1 min-h-0 flex flex-col overflow-hidden outline-none data-[state=inactive]:hidden">
              {bugs.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    icon={<Warning className="h-5 w-5" />}
                    title="No issues found"
                    description="Run this flow to start discovering issues."
                    className="py-16"
                  />
                </div>
              ) : (
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  {/* Sidebar */}
                  <div className="w-[340px] flex-shrink-0 flex flex-col border-r border-border">
                    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
                      {bugs.map((bug, i) => {
                        const selected = i === selectedBugIndex;
                        const reportedIso = bug.reported_at ?? bug.reportedAt ?? "";
                        return (
                          <button key={bug.id ?? i} type="button" onClick={() => setSelectedBugIndex(i)} className="w-full text-left block">
                            <div className={cn(
                              "bg-card border border-border rounded-lg p-3 transition-all hover:border-primary/30",
                              selected && "border-primary/40 bg-primary/5",
                            )}>
                              <p className="text-[13px] font-medium text-foreground leading-snug mb-1.5">{bug.name}</p>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <FlowSeverityChip severity={bug.severity} />
                                <FlowCategoryChip category={bug.category} />
                                {bug.status && bug.status !== "open" && (
                                  <Badge variant={BUG_STATUS_BADGE[bug.status] ?? "neutral"} className="capitalize text-[10px]">
                                    {bugStatusLabel(bug.status)}
                                  </Badge>
                                )}
                                <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
                                  {reportedIso ? new Date(reportedIso).toLocaleDateString() : ""}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Detail panel */}
                  <div className="flex-1 min-w-0 overflow-y-auto">
                    {(() => {
                      const bug = bugs[selectedBugIndex];
                      if (!bug) return null;
                      const runKey = bug.run_id ?? bug.runId;
                      const src = runScreenshotFileUrl(runKey, bug.screenshot_path ?? bug.screenshotPath);
                      const isOpen = !bug.status || bug.status === "open" || bug.status === "in_progress";
                      const reportedIso = bug.reported_at ?? bug.reportedAt ?? "";
                      return (
                        <div className="flex flex-col animate-fade-in">
                          {/* Actions — primary CTA */}
                          <div className="flex-shrink-0 border-b border-border px-5 py-3 bg-surface-2 dark:bg-surface-3 flex items-center gap-2">
                            {bug.id && currentProjectId ? (
                              isOpen ? (
                                <>
                                  <Button
                                    variant="default"
                                    disabled={bugActionBusy === bug.id}
                                    loading={bugActionBusy === bug.id}
                                    onClick={async () => {
                                      if (!currentProjectId || !bug.id) return;
                                      setBugActionBusy(bug.id);
                                      await patchProjectBug(currentProjectId, bug.id, { status: "in_progress" }).catch(() => {});
                                      await load();
                                      setBugActionBusy(null);
                                    }}
                                  >
                                    Mark for fix
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={bugActionBusy === bug.id}
                                    onClick={async () => {
                                      if (!currentProjectId || !bug.id) return;
                                      setBugActionBusy(bug.id);
                                      await patchProjectBug(currentProjectId, bug.id, { status: "wont_fix" }).catch(() => {});
                                      await load();
                                      setBugActionBusy(null);
                                    }}
                                  >
                                    Ignore
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Badge variant={BUG_STATUS_BADGE[bug.status!] ?? "neutral"} className="capitalize">
                                    {bugStatusLabel(bug.status!)}
                                  </Badge>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-3 text-[11px]"
                                    disabled={bugActionBusy === bug.id}
                                    onClick={async () => {
                                      if (!currentProjectId || !bug.id) return;
                                      setBugActionBusy(bug.id);
                                      await patchProjectBug(currentProjectId, bug.id, { status: "open" }).catch(() => {});
                                      await load();
                                      setBugActionBusy(null);
                                    }}
                                  >
                                    Undo
                                  </Button>
                                </>
                              )
                            ) : (
                              <Button size="sm" variant="ghost" className="h-7 px-3 text-[11px] gap-1"
                                onClick={() => navigate(`/runs/${runKey}`)}>
                                View Run <ArrowSquareOut className="h-3 w-3" />
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 px-3 text-[11px] gap-1 ml-auto"
                              onClick={() => navigate(`/runs/${runKey}`)}>
                              View Run <ArrowSquareOut className="h-3 w-3" />
                            </Button>
                          </div>

                          {/* Screenshot */}
                          {src && (
                            <div className="border-b border-border bg-surface-2 dark:bg-surface-3 px-6 py-5">
                              <div className="mx-auto w-full max-w-4xl">
                                <BugScreenshotZoomDialog
                                  src={src}
                                  triggerClassName="w-full"
                                  thumbnailClassName="w-full max-h-[400px] object-contain"
                                />
                              </div>
                            </div>
                          )}

                          {/* Title + chips */}
                          <div className="px-6 pt-5 pb-3">
                            <h2 className="text-[15px] font-semibold text-foreground leading-snug">{bug.name}</h2>
                            <div className="flex items-center gap-1.5 flex-wrap mt-2">
                              <FlowSeverityChip severity={bug.severity} />
                              <FlowCategoryChip category={bug.category} />
                              {bug.url && (
                                <a href={bug.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/60 hover:text-foreground transition-colors truncate max-w-[200px]">
                                  <Globe className="h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">{bug.url}</span>
                                </a>
                              )}
                              <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
                                {reportedIso ? new Date(reportedIso).toLocaleString() : "—"}
                              </span>
                            </div>
                          </div>

                          {/* Description */}
                          {bug.description && (
                            <div className="px-6 pb-6">
                              <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{bug.description}</p>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* Runs */}
            <TabsContent value="runs" className="px-6 py-4 overflow-y-auto">
              <RunList
                runs={runs}
                emptyMessage="No runs yet. Hit Run to execute this flow."
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit flow</DialogTitle>
            <DialogDescription>Update this test flow configuration.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Name
              </label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Description
              </label>
              <Textarea
                value={formIntent}
                onChange={(e) => setFormIntent(e.target.value)}
                rows={3}
                className="text-[13px] resize-y"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Context{" "}
                <span className="text-muted-foreground/50 normal-case font-normal">optional</span>
              </label>
              <Textarea
                value={formContext}
                onChange={(e) => setFormContext(e.target.value)}
                rows={2}
                className="text-[13px] resize-y"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium text-foreground">Max steps</p>
                <p className="text-[11px] text-muted-foreground/60">Override default 50-step limit (max 250)</p>
              </div>
              <Input
                type="number"
                min={1}
                max={250}
                value={formMaxSteps}
                onChange={(e) => setFormMaxSteps(e.target.value)}
                placeholder="50"
                className="w-20 h-7 text-[12px] text-right"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleSaveEdit}
              disabled={formSaving || !formName.trim() || !formIntent.trim()}
              loading={formSaving}
            >
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
