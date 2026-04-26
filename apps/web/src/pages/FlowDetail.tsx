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
import {
  fetchTests,
  fetchEnvironments,
  fetchProjectRuns,
  fetchProjectBugs,
  runProjectTest,
  updateTest,
  patchProjectBug,
} from "@/projectApi";
import { BUG_SEVERITY_STATUS_DOT } from "@/lib/bug-issue-display";
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
  const [expandedBugId, setExpandedBugId] = React.useState<string | null>(null);
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
      const res = await runProjectTest(test.project_id, defaultEnvId, "", test.id);
      navigate(`/runs/${res.runId}`);
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
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="animate-fade-in">
          <Tabs defaultValue="overview">
            <TabsList>
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
            <TabsContent value="overview">
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
            <TabsContent value="issues">
              {bugs.length === 0 ? (
                <EmptyState
                  icon={<Warning className="h-5 w-5" />}
                  title="No issues found"
                  description="Run this flow to start discovering issues."
                  className="py-16"
                />
              ) : (
                <div className="space-y-1.5">
                  {bugs.map((bug, i) => {
                    const id = bug.id ?? `${bug.run_id}-${i}`;
                    const isExpanded = expandedBugId === id;
                    const reportedIso = bug.reported_at ?? bug.reportedAt ?? "";
                    const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
                    const STATUS_VARIANT: Record<string, "success" | "warning" | "neutral" | "destructive"> = {
                      open: "warning", in_progress: "warning", resolved: "success", wont_fix: "neutral",
                    };
                    return (
                      <div
                        key={id}
                        className={`rounded-lg border border-border bg-surface-2 dark:bg-surface-3 overflow-hidden ${isExpanded ? "ring-1 ring-border" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedBugId(isExpanded ? null : id)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors min-w-0"
                        >
                          {isExpanded
                            ? <CaretDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            : <CaretRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                          <StatusDot status={BUG_SEVERITY_STATUS_DOT[bug.severity] ?? "stale"} />
                          <span className="text-[13px] font-medium text-foreground truncate flex-1 min-w-0">
                            {bug.name}
                          </span>
                          <BugCategoryTag category={bug.category} />
                          <Badge variant={STATUS_VARIANT[bug.status] ?? "neutral"} className="capitalize flex-shrink-0">
                            {bug.status.replace("_", " ")}
                          </Badge>
                          <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0">
                            {reportedIso ? new Date(reportedIso).toLocaleDateString() : ""}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-border px-4 py-4 space-y-4 bg-surface-1 dark:bg-surface-2 animate-fade-in">
                            {bug.description && (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                                  Description
                                </p>
                                <p className="text-[13px] text-foreground whitespace-pre-wrap">{bug.description}</p>
                              </div>
                            )}

                            {(() => {
                              const runKey = bug.run_id ?? bug.runId;
                              const src = runScreenshotFileUrl(runKey, bug.screenshot_path ?? bug.screenshotPath);
                              if (!src) return null;
                              return (
                                <div>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                                    Screenshot
                                  </p>
                                  <BugScreenshotZoomDialog src={src} />
                                </div>
                              );
                            })()}

                            <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
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
                              <div className="flex flex-wrap items-center gap-2 ml-auto">
                                {bug.id && (bug.status === "open" || bug.status === "in_progress") && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[11px]"
                                    disabled={bugActionBusy === bug.id}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (!currentProjectId || !bug.id) return;
                                      setBugActionBusy(bug.id);
                                      await patchProjectBug(currentProjectId, bug.id, { status: "resolved" }).catch(() => {});
                                      await load();
                                      setBugActionBusy(null);
                                    }}
                                  >
                                    Resolve
                                  </Button>
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
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            {/* Runs */}
            <TabsContent value="runs">
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
