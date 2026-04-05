import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Flask,
  Plus,
  Play,
  Pencil,
  Trash,
  Keyboard,
  CursorClick,
  NavigationArrow,
  Globe,
  Repeat,
  CheckCircle,
  CaretDown,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RunList } from "@/components/RunList";
import { cn } from "@/lib/utils";
import { statusVariant, relativeTime } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchEnvironments, fetchTests, createTest, updateTest, deleteTest,
  runProjectTest, fetchProjectRuns,
} from "@/projectApi";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RegressionStep = {
  action: string;
  role?: string;
  name?: string;
  value?: string;
  url?: string;
  purpose?: string;
  doneWhen?: { type: string; value?: string; role?: string; name?: string; text?: string };
};

type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  max_steps?: number | null;
  created_at: string;
  run_count?: number;
  regression_plan?: RegressionStep[] | null;
  plan_status?: "none" | "ready" | "stale" | null;
  plan_success_count?: number;
};

// ─── Main Page ──────────────────────────────────────────────────────────────

export const TestsPlans: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentProjectId } = useProject();

  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);

  const [tests, setTests] = React.useState<SavedTest[]>([]);
  const [selectedTest, setSelectedTest] = React.useState<SavedTest | null>(null);

  // Create / edit dialog
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SavedTest | null>(null);
  const [formName, setFormName] = React.useState("");
  const [formIntent, setFormIntent] = React.useState("");
  const [formContext, setFormContext] = React.useState("");
  const [formMaxSteps, setFormMaxSteps] = React.useState<string>("");
  const [formSaving, setFormSaving] = React.useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = React.useState<SavedTest | null>(null);

  // Adhoc
  const [adhocIntent, setAdhocIntent] = React.useState("");
  const [adhocRunning, setAdhocRunning] = React.useState(false);

  // Detail tabs
  const [testTab, setTestTab] = React.useState<string>("runs");

  // Runs for detail
  const [flowRuns, setFlowRuns] = React.useState<any[]>([]);
  const [runsLoading, setRunsLoading] = React.useState(false);

  const [running, setRunning] = React.useState<string | null>(null);

  // ─── Init ───────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!currentProjectId) return;
    fetchEnvironments(currentProjectId).then((res) => {
      const envs = res.environments || [];
      setEnvironments(envs);
      setSelectedEnvId(envs[0]?.id || null);
    });
    loadTests();
    setSelectedTest(null);
    setDialogOpen(false);
  }, [currentProjectId]);

  async function loadTests() {
    if (!currentProjectId) return;
    const res = await fetchTests(currentProjectId);
    setTests((res.tests || []).filter(Boolean));
  }

  // Open a specific flow when navigated from command palette (or similar).
  React.useEffect(() => {
    const id = (location.state as { selectTestId?: string } | null)?.selectTestId;
    if (!id || tests.length === 0) return;
    const match = tests.find((t) => t.id === id);
    if (match) {
      setSelectedTest(match);
      setTestTab("runs");
      navigate(".", { replace: true, state: {} });
    }
  }, [tests, location.state, navigate]);

  // ─── Load runs for selected test ─────────────────────────────────────────

  React.useEffect(() => {
    if (testTab !== "runs" || !currentProjectId || !selectedTest) return;
    setRunsLoading(true);
    fetchProjectRuns(currentProjectId)
      .then((res) => {
        const runs = (res.runs ?? []).filter((r: any) => r.test_id === selectedTest.id);
        setFlowRuns(runs);
      })
      .finally(() => setRunsLoading(false));
  }, [testTab, currentProjectId, selectedTest?.id]);

  React.useEffect(() => {
    if (testTab === "memory") setTestTab("runs");
  }, [testTab]);

  // ─── Select ─────────────────────────────────────────────────────────────

  function selectTest(test: SavedTest) {
    if (selectedTest?.id === test.id) {
      setSelectedTest(null);
      return;
    }
    setSelectedTest(test);
    setTestTab("runs");
  }

  // ─── Create / Edit ──────────────────────────────────────────────────────

  function openCreate() {
    setEditing(null);
    setFormName("");
    setFormIntent("");
    setFormContext("");
    setFormMaxSteps("");
    setDialogOpen(true);
  }

  function openEdit(test: SavedTest) {
    setEditing(test);
    setFormName(test.name);
    setFormIntent(test.intent);
    setFormContext(test.context ?? "");
    setFormMaxSteps(test.max_steps != null ? String(test.max_steps) : "");
    setDialogOpen(true);
  }

  async function handleSaveForm() {
    if (!currentProjectId || !formName.trim() || !formIntent.trim()) return;
    setFormSaving(true);
    const parsedMaxSteps = formMaxSteps.trim() !== "" ? Math.min(Math.max(1, parseInt(formMaxSteps, 10)), 250) : undefined;
    try {
      if (editing) {
        const res = await updateTest(currentProjectId, editing.id, {
          name: formName.trim(), intent: formIntent.trim(),
          context: formContext.trim() || undefined,
          max_steps: parsedMaxSteps ?? null,
        });
        const updated = res.test;
        setTests((prev) => prev.map((t) => t.id === updated.id ? updated : t));
        if (selectedTest?.id === updated.id) setSelectedTest(updated);
        setEditing(null);
      } else {
        const res = await createTest(currentProjectId, {
          name: formName.trim(), intent: formIntent.trim(),
          context: formContext.trim() || undefined,
          max_steps: parsedMaxSteps,
        });
        setTests((prev) => [res.test, ...prev]);
        setSelectedTest(res.test);
      }
      setDialogOpen(false);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDelete(test: SavedTest) {
    await deleteTest(test.project_id, test.id);
    setTests((prev) => prev.filter((t) => t.id !== test.id));
    if (selectedTest?.id === test.id) setSelectedTest(null);
    setDeleteTarget(null);
  }

  // ─── Run ────────────────────────────────────────────────────────────────

  async function handleRunSaved(test: SavedTest) {
    if (!selectedEnvId) return;
    setRunning(test.id);
    try {
      const res = await runProjectTest(test.project_id, selectedEnvId, "", test.id);
      navigate(`/runs/${res.runId}`);
    } finally {
      setRunning(null);
    }
  }

  async function handleAdhocRun() {
    if (!currentProjectId || !selectedEnvId || !adhocIntent.trim()) return;
    setAdhocRunning(true);
    try {
      const res = await runProjectTest(currentProjectId, selectedEnvId, adhocIntent.trim());
      navigate(`/runs/${res.runId}`);
    } finally {
      setAdhocRunning(false);
    }
  }

  // ─── Plan status badge helper ────────────────────────────────────────────

  function planBadge(test: SavedTest) {
    if (test.plan_status === "ready") {
      return (
        <Badge
          variant="outline"
          className="shrink-0 rounded-md border-status-pass/35 bg-status-pass/12 px-2 py-0.5 text-[10px] font-medium text-status-pass"
        >
          Script generated
        </Badge>
      );
    }
    if (test.plan_status === "stale") {
      return (
        <Badge
          variant="outline"
          className="shrink-0 rounded-md border-status-warn/35 bg-status-warn/10 px-2 py-0.5 text-[10px] font-medium text-status-warn"
        >
          Script stale
        </Badge>
      );
    }
    return null;
  }

  const canSave = formName.trim().length > 0 && formIntent.trim().length > 0;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Flask className="h-4 w-4" />}
        title="Flows"
        description={tests.length > 0 ? `${tests.length} flow${tests.length !== 1 ? "s" : ""}` : undefined}
      >
        <Button size="sm" onClick={openCreate} disabled={!currentProjectId} className="gap-1.5 h-7 text-[12px]">
          <Plus className="h-3.5 w-3.5" />
          New Flow
        </Button>
      </PageHeader>

      <div className="p-6 animate-fade-in space-y-6">
        {/* ── Ad-hoc runner ──────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide mb-2">
              Ad-hoc run
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={adhocIntent}
                onChange={(e) => setAdhocIntent(e.target.value)}
                placeholder="Describe what the agent should do..."
                className="h-8 text-[13px] flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") handleAdhocRun(); }}
              />
              {environments.length > 0 && (
                <Select
                  value={selectedEnvId ?? ""}
                  onChange={(e) => setSelectedEnvId(e.target.value)}
                  className="w-[160px] h-8 text-[12px]"
                >
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>{env.name}</option>
                  ))}
                </Select>
              )}
              <Button
                size="sm"
                onClick={handleAdhocRun}
                disabled={adhocRunning || !adhocIntent.trim() || !selectedEnvId || !currentProjectId}
                loading={adhocRunning}
                className="gap-1.5 h-8"
              >
                <Play className="h-3 w-3" />
                Run
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Flows list ─────────────────────────────────────────────── */}
        {!currentProjectId ? (
          <EmptyState title="Select a project" className="py-12" />
        ) : tests.length === 0 ? (
          <EmptyState
            icon={<Flask className="h-5 w-5" />}
            title="No flows yet"
            description="Create a test flow to get started."
            className="py-12"
          />
        ) : (
          <div className="space-y-3">
            {tests.map((test) => {
              const isExpanded = selectedTest?.id === test.id;
              return (
                <Card key={test.id} className="overflow-hidden">
                  {/* Card header row */}
                  <button
                    onClick={() => selectTest(test)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                      isExpanded ? "bg-accent/50" : "hover:bg-accent/30",
                    )}
                  >
                    <CaretDown
                      className={cn(
                        "h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0 transition-transform duration-150",
                        isExpanded ? "rotate-0" : "-rotate-90",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-foreground truncate">
                          {test.name}
                        </span>
                        {test.run_count != null && test.run_count > 0 && (
                          <span className="text-[10px] font-mono text-muted-foreground/50">
                            {test.run_count} run{test.run_count !== 1 ? "s" : ""}
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-muted-foreground/40">
                          {relativeTime(test.created_at)}
                        </span>
                      </div>
                      {test.intent && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {test.intent.trim().replace(/\s+/g, " ").slice(0, 100)}
                          {test.intent.trim().replace(/\s+/g, " ").length > 100 ? "..." : ""}
                        </p>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      {planBadge(test)}
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRunSaved(test)}
                          disabled={running === test.id || !selectedEnvId}
                          className="h-7 gap-1.5 text-[11px]"
                        >
                          <Play className="h-3 w-3" />
                          {running === test.id ? "Starting..." : "Run"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(test)} className="h-7 w-7 p-0">
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(test)}
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail tabs */}
                  {isExpanded && (
                    <div className="border-t border-border animate-fade-in">
                      <Tabs value={testTab} onValueChange={setTestTab} className="flex flex-col">
                        <TabsList className="px-4 flex-shrink-0">
                          <TabsTrigger value="runs">Runs</TabsTrigger>
                          <TabsTrigger value="script">
                            Script
                            {test.plan_status === "ready" && (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-pass" />
                            )}
                          </TabsTrigger>
                          <TabsTrigger value="details">Details</TabsTrigger>
                        </TabsList>

                        <div className="max-h-[500px] overflow-y-auto">
                          <TabsContent value="runs" className="px-4 pb-4">
                            <RunList
                              runs={flowRuns}
                              title="Recent runs"
                              loading={runsLoading}
                              emptyMessage="No runs yet. Hit Run to execute this flow."
                            />
                          </TabsContent>

                          <TabsContent value="script" className="px-4 pb-4">
                            <ScriptTab
                              plan={test.regression_plan}
                              planStatus={test.plan_status}
                              successCount={test.plan_success_count}
                            />
                          </TabsContent>

                          <TabsContent value="details" className="px-4 pb-4">
                            <DetailsTab test={test} />
                          </TabsContent>
                        </div>
                      </Tabs>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Create / Edit Dialog ──────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit flow" : "New flow"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update this test flow configuration." : "Define a new test flow for the agent to execute."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Name</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Checkout flow"
                autoFocus
                className="h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Intent</label>
              <Textarea
                value={formIntent}
                onChange={(e) => setFormIntent(e.target.value)}
                rows={3}
                placeholder="Describe what the agent should do..."
                className="text-[13px] resize-y"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Context <span className="text-muted-foreground/50 normal-case font-normal">optional</span>
              </label>
              <Textarea
                value={formContext}
                onChange={(e) => setFormContext(e.target.value)}
                rows={2}
                placeholder="Expected behaviors, known issues..."
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
            <Button size="sm" onClick={handleSaveForm} disabled={formSaving || !canSave} loading={formSaving}>
              {editing ? "Save changes" : "Create flow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete flow</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ─── Script Tab ───────────────────────────────────────────────────────────────

function ScriptTab({ plan, planStatus, successCount }: {
  plan?: RegressionStep[] | null;
  planStatus?: string | null;
  successCount?: number;
}) {
  const status = planStatus ?? "none";
  const steps = plan ?? [];
  const showEmptyState = status === "none" || steps.length === 0;

  return (
    <div className="w-full space-y-5">
      {showEmptyState ? (
        <div className="flex justify-center">
          <EmptyState
            className="w-full max-w-lg py-16"
            icon={<Repeat className="h-5 w-5" />}
            title="No replay plan yet"
            description="Run this flow successfully once. We’ll save the step sequence and reuse it on the next run."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Replay plan
              </p>
              <p className="mt-1.5 text-[14px] font-medium text-foreground tabular-nums">
                {steps.length} step{steps.length !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex flex-col gap-1.5 text-[11px] sm:items-end sm:text-right">
              {status === "ready" && (
                <span className="inline-flex items-center gap-1.5 text-status-pass">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-pass" aria-hidden />
                  In sync
                </span>
              )}
              {status === "stale" && (
                <span className="inline-flex items-center gap-1.5 text-status-warn">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warn" aria-hidden />
                  Out of date — refreshes on next run
                </span>
              )}
              {(successCount ?? 0) > 0 && (
                <span className="font-mono text-muted-foreground/70 tabular-nums">
                  {successCount} successful replay{successCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>

          <RegressionPlanView steps={steps} />
        </>
      )}
    </div>
  );
}

// ─── Details Tab ──────────────────────────────────────────────────────────────

const DEFAULT_FLOW_MAX_STEPS = 50;

function DetailsTab({ test }: { test: SavedTest }) {
  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide mb-2">Max steps</p>
        <p className="text-[13px] text-foreground tabular-nums">
          {test.max_steps != null ? test.max_steps : DEFAULT_FLOW_MAX_STEPS}
          {test.max_steps == null && (
            <span className="text-muted-foreground/60 font-normal"> (default)</span>
          )}
        </p>
      </div>

      <div>
        <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide mb-2">Intent</p>
        <div className="rounded-md bg-muted/40 border border-border px-4 py-3 text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">
          {test.intent}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide mb-2">Context</p>
        {test.context ? (
          <div className="rounded-md bg-muted/40 border border-border px-4 py-3 text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">
            {test.context}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground/50 italic">No context set</p>
        )}
      </div>
    </div>
  );
}

// ─── Shared Regression Plan Step Viewer (exported for PageDetail.tsx) ────────

const STEP_ACTION_COLORS: Record<string, string> = {
  click:         "text-emerald-600 dark:text-emerald-400",
  fill:          "text-blue-600 dark:text-blue-400",
  navigate:      "text-violet-600 dark:text-violet-400",
  assert:        "text-amber-600 dark:text-amber-400",
  pressKey:      "text-cyan-600 dark:text-cyan-400",
  selectOption:  "text-purple-600 dark:text-purple-400",
  scroll:        "text-muted-foreground",
  back:          "text-muted-foreground",
  wait:          "text-muted-foreground/60",
};

function StepActionIcon({ action }: { action: string }) {
  const cls = "h-4 w-4 shrink-0";
  if (action === "fill") return <Keyboard className={cn(cls, "text-blue-500/75")} />;
  if (action === "click") return <CursorClick className={cn(cls, "text-emerald-600/80 dark:text-emerald-400/85")} />;
  if (action === "navigate") return <NavigationArrow className={cn(cls, "text-violet-500/75")} />;
  if (action === "assert") return <CheckCircle className={cn(cls, "text-amber-500/75")} />;
  return <Globe className={cn(cls, "text-muted-foreground/55")} />;
}

export function RegressionPlanView({ steps }: { steps: RegressionStep[] }) {
  return (
    <div className="w-full rounded-lg border border-border bg-card overflow-hidden">
      {steps.map((step, i) => (
        <div
          key={i}
          className={cn(
            "grid w-full grid-cols-[1.5rem_1.5rem_minmax(0,1fr)] items-start gap-x-1.5 pl-2 pr-4 py-3 text-[12px] sm:grid-cols-[1.625rem_1.75rem_minmax(0,1fr)] sm:pl-2.5 sm:pr-5",
            i > 0 && "border-t border-border",
          )}
        >
          <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums text-right pt-0.5">
            {i + 1}
          </span>
          <div className="pt-0.5">
            <StepActionIcon action={step.action} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={cn("font-mono font-medium", STEP_ACTION_COLORS[step.action] ?? "text-foreground")}>
                {step.action}
              </span>
              {step.role && step.name && (
                <span className="font-mono text-foreground/80">
                  {step.role}:<span className="text-foreground">&quot;{step.name}&quot;</span>
                </span>
              )}
              {!step.role && step.name && (
                <span className="font-mono text-foreground/80">&quot;{step.name}&quot;</span>
              )}
              {step.value && step.action !== "navigate" && (
                <span className="text-muted-foreground">= &quot;{step.value}&quot;</span>
              )}
              {step.action === "navigate" && step.value && (
                <span className="font-mono text-violet-500/80 truncate">{step.value}</span>
              )}
            </div>
            {step.purpose && (
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">{step.purpose}</p>
            )}
            {step.url && step.action !== "navigate" && (
              <p className="text-[10px] font-mono text-muted-foreground/30 mt-0.5 truncate">{step.url}</p>
            )}
            {step.doneWhen && (
              <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                done when: {step.doneWhen.type}
                {step.doneWhen.value && ` "${step.doneWhen.value}"`}
                {step.doneWhen.text && ` "${step.doneWhen.text}"`}
                {step.doneWhen.name && ` ${step.doneWhen.role}:"${step.doneWhen.name}"`}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
