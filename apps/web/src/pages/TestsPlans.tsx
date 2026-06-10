import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ListChecks,
  Plus,
  Play,
  FastForward,
  Pencil,
  Trash,
  MagnifyingGlass,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchEnvironments, fetchTests, createTest, updateTest, deleteTest,
  toggleTest, runProjectTest, discoverFlows, fetchDiscoveryStatus,
} from "@/projectApi";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────────────

type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  max_steps?: number | null;
  created_at: string;
  run_count?: number;
  issues_count?: number;
  enabled: boolean;
};


// ─── Main Page ──────────────────────────────────────────────────────────────

export const TestsPlans: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentProjectId } = useProject();

  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);

  const [tests, setTests] = React.useState<SavedTest[]>([]);

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

  const [running, setRunning] = React.useState<string | null>(null);
  const [runAllBusy, setRunAllBusy] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [activeDiscoveryRunId, setActiveDiscoveryRunId] = React.useState<string | null>(null);

  // ─── Init ───────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!currentProjectId) return;
    fetchEnvironments(currentProjectId).then((res) => {
      const envs = res.environments || [];
      setEnvironments(envs);
      setSelectedEnvId(envs[0]?.id || null);
    });
    loadTests();
    setDialogOpen(false);
    fetchDiscoveryStatus(currentProjectId).then((res) => {
      if (res.active && res.runId) {
        setActiveDiscoveryRunId(res.runId);
        setDiscovering(true);
      } else {
        setActiveDiscoveryRunId(null);
        setDiscovering(false);
      }
    }).catch(() => {});
  }, [currentProjectId]);

  async function loadTests() {
    if (!currentProjectId) return;
    const res = await fetchTests(currentProjectId);
    setTests((res.tests || []).filter(Boolean));
  }

  // Navigate to detail when command palette selects a specific flow.
  React.useEffect(() => {
    const id = (location.state as { selectTestId?: string } | null)?.selectTestId;
    if (!id || tests.length === 0) return;
    const match = tests.find((t) => t.id === id);
    if (match) {
      navigate(`/tests/${match.id}`, { replace: true });
    }
  }, [tests, location.state, navigate]);

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
        setTests((prev) => prev.map((t) => t.id === res.test.id ? res.test : t));
        setEditing(null);
      } else {
        const res = await createTest(currentProjectId, {
          name: formName.trim(), intent: formIntent.trim(),
          context: formContext.trim() || undefined,
          max_steps: parsedMaxSteps,
        });
        setTests((prev) => [res.test, ...prev]);
      }
      setDialogOpen(false);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDelete(test: SavedTest) {
    await deleteTest(test.project_id, test.id);
    setTests((prev) => prev.filter((t) => t.id !== test.id));
    setDeleteTarget(null);
  }

  // ─── Run ────────────────────────────────────────────────────────────────

  async function handleToggleEnabled(test: SavedTest, enabled: boolean) {
    const prevEnabled = test.enabled;
    setTests((cur) => cur.map((t) => (t.id === test.id ? { ...t, enabled } : t)));
    try {
      await toggleTest(test.project_id, test.id, enabled);
    } catch {
      setTests((cur) => cur.map((t) => (t.id === test.id ? { ...t, enabled: prevEnabled } : t)));
    }
  }

  async function handleRunSaved(test: SavedTest) {
    if (!selectedEnvId) return;
    setRunning(test.id);
    try {
      await runProjectTest(test.project_id, selectedEnvId, "", test.id);
      toast.success("Run queued");
    } finally {
      setRunning(null);
    }
  }

  async function handleRunAll() {
    if (!currentProjectId || !selectedEnvId) return;
    const targets = tests.filter((t) => t.enabled);
    if (targets.length === 0) return;
    setRunAllBusy(true);
    try {
      for (const t of targets) {
        await runProjectTest(t.project_id, selectedEnvId, "", t.id);
      }
      toast.success(`${targets.length} run${targets.length === 1 ? "" : "s"} queued`);
    } finally {
      setRunAllBusy(false);
    }
  }

  async function handleDiscover() {
    if (activeDiscoveryRunId) {
      navigate(`/runs/${activeDiscoveryRunId}`);
      return;
    }
    if (!currentProjectId || !selectedEnvId) return;
    setDiscovering(true);
    try {
      const { runId } = await discoverFlows(currentProjectId, selectedEnvId);
      setActiveDiscoveryRunId(runId);
      navigate(`/runs/${runId}`);
    } catch {
      setDiscovering(false);
      toast.error("Discovery failed to start");
    }
  }

  async function handleAdhocRun() {
    if (!currentProjectId || !selectedEnvId || !adhocIntent.trim()) return;
    setAdhocRunning(true);
    try {
      await runProjectTest(currentProjectId, selectedEnvId, adhocIntent.trim());
      toast.success("Run queued");
    } finally {
      setAdhocRunning(false);
    }
  }

  const canSave = formName.trim().length > 0 && formIntent.trim().length > 0;
  const enabledCount = tests.filter((t) => t.enabled).length;
  const totalRunCount = tests.reduce((sum, t) => sum + (t.run_count ?? 0), 0);
  const totalIssuesFound = tests.reduce((sum, t) => sum + (t.issues_count ?? 0), 0);
  const testedFlows = tests.filter((t) => (t.run_count ?? 0) > 0).length;
  const flowsWithIssues = tests.filter((t) => (t.issues_count ?? 0) > 0).length;
  const cleanFlows = tests.filter((t) => (t.run_count ?? 0) > 0 && (t.issues_count ?? 0) === 0).length;
  const untestedFlows = Math.max(0, tests.length - testedFlows);

  const [flowFilter, setFlowFilter] = React.useState("");

  const filteredTests = React.useMemo(() => {
    if (!flowFilter.trim()) return tests;
    const q = flowFilter.toLowerCase();
    return tests.filter(
      (t) => t.name.toLowerCase().includes(q) || t.intent.toLowerCase().includes(q),
    );
  }, [tests, flowFilter]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<ListChecks className="h-4 w-4" />} title="Flows" />
        <EmptyState
          icon={<ListChecks className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view flows."
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<ListChecks className="h-4 w-4" />}
        title="Flows"
        description={tests.length > 0 ? `${tests.length} flow${tests.length !== 1 ? "s" : ""}` : undefined}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-8 py-5 w-full space-y-4 animate-page-enter">

          {/* ── Stat cards ────────────────────────────────────────────── */}
          <aside className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Signal */}
            <div className="glass-card-flat card-stagger px-3 py-3">
              <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Signal</p>
              <div className="mt-2 flex items-center gap-3">
                <div
                  className="relative h-14 w-14 rounded-full shrink-0"
                  style={{
                    background: `conic-gradient(
                      rgb(16 185 129) 0 ${(cleanFlows / Math.max(tests.length, 1)) * 360}deg,
                      rgb(245 158 11) ${(cleanFlows / Math.max(tests.length, 1)) * 360}deg ${((cleanFlows + flowsWithIssues) / Math.max(tests.length, 1)) * 360}deg,
                      rgb(148 163 184 / 0.35) ${((cleanFlows + flowsWithIssues) / Math.max(tests.length, 1)) * 360}deg 360deg
                    )`,
                  }}
                >
                  <div className="absolute inset-2 rounded-full bg-white/80 dark:bg-white/10 backdrop-blur-sm flex items-center justify-center">
                    <span className="text-[10px] font-semibold tabular-nums text-foreground">
                      {testedFlows}/{tests.length}
                    </span>
                  </div>
                </div>
                <div className="space-y-0.5 text-[11px] text-muted-foreground">
                  <p>{cleanFlows} clean</p>
                  <p>{flowsWithIssues} issues</p>
                  <p>{untestedFlows} untested</p>
                </div>
              </div>
            </div>

            {/* Issues Found */}
            <div className="glass-card-flat card-stagger px-3 py-3">
              <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Issues Found</p>
              <p className={cn(
                "mt-2 text-[26px] font-semibold tabular-nums",
                totalIssuesFound > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
              )}>
                {tests.length === 0 ? "—" : totalIssuesFound}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {totalIssuesFound === 0
                  ? "No bugs detected"
                  : `Across ${flowsWithIssues} flow${flowsWithIssues !== 1 ? "s" : ""}`}
              </p>
            </div>

            {/* Total Runs */}
            <div className="glass-card-flat card-stagger px-3 py-3">
              <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Total Runs</p>
              <p className="mt-2 text-[26px] font-semibold tabular-nums text-foreground">
                {tests.length === 0 ? "—" : totalRunCount}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {totalRunCount === 0 ? "No runs yet" : `Across ${tests.length} flow${tests.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </aside>

          {/* ── Main content ──────────────────────────────────────────── */}
          <main className="space-y-3">
            {!currentProjectId ? (
              <EmptyState title="Select a project" className="py-12" />
            ) : (
              <>
                {/* Section header: Flows title + env + run all */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Flows ({filteredTests.length})
                  </p>
                  <div className="flex items-center gap-2">
                    {environments.length > 0 ? (
                      <Select
                        value={selectedEnvId ?? ""}
                        onChange={(e) => setSelectedEnvId(e.target.value)}
                        className="w-[170px] h-8 text-[12px]"
                      >
                        {environments.map((env) => (
                          <option key={env.id} value={env.id}>{env.name}</option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-[12px] text-muted-foreground/70">No environments</span>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={!selectedEnvId || enabledCount === 0 || runAllBusy}
                      loading={runAllBusy}
                      onClick={() => void handleRunAll()}
                      className="gap-1.5 h-8"
                    >
                      {!runAllBusy && <Play className="h-3.5 w-3.5" />}
                      Run all{enabledCount > 0 ? ` (${enabledCount})` : ""}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!selectedEnvId || discovering}
                      loading={discovering}
                      onClick={() => void handleDiscover()}
                      className="gap-1.5 h-8 text-[12px]"
                    >
                      {!discovering && <MagnifyingGlassPlus className="h-3.5 w-3.5" />}
                      {discovering ? "Discovering..." : "Discover"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={openCreate}
                      disabled={!currentProjectId}
                      className="gap-1.5 h-8 text-[12px]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New Flow
                    </Button>
                  </div>
                </div>

                {/* Flow tiles (Quick run always first) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  <div className="glass-card-flat p-3 flex flex-col gap-2 min-h-[8rem]">
                    <div className="flex items-center gap-2 min-w-0">
                      <FastForward className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[13px] font-medium text-foreground truncate">Quick run</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60">
                      Run an ad-hoc prompt without creating a saved flow.
                    </p>
                    <div className="mt-auto flex items-center gap-2">
                      <Input
                        value={adhocIntent}
                        onChange={(e) => setAdhocIntent(e.target.value)}
                        placeholder="Describe what the agent should do..."
                        className="h-8 text-[13px] flex-1"
                        onKeyDown={(e) => { if (e.key === "Enter") handleAdhocRun(); }}
                      />
                      <Button
                        size="sm"
                        onClick={handleAdhocRun}
                        disabled={adhocRunning || !adhocIntent.trim() || !selectedEnvId || !currentProjectId}
                        loading={adhocRunning}
                        className="gap-1.5 h-8 shrink-0"
                      >
                        {!adhocRunning && <Play className="h-3 w-3" />}
                        Run
                      </Button>
                    </div>
                  </div>

                  {filteredTests.map((test) => {
                      return (
                        <div
                          key={test.id}
                          className={cn(
                            "glass-card-flat card-stagger p-3 flex flex-col gap-2 min-h-[8rem]",
                            !test.enabled && "opacity-50",
                          )}
                        >
                          {/* Top: name + switch */}
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => navigate(`/tests/${test.id}`)}
                              className="min-w-0 flex-1 text-left space-y-1 group/link"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={cn("text-[13px] font-medium text-foreground truncate", !test.enabled && "line-through")}>
                                  {test.name}
                                </span>
                              </div>
                              {test.intent && (
                                <p className="text-[11px] text-muted-foreground/60 truncate">
                                  {test.intent.trim()}
                                </p>
                              )}
                            </button>
                            <div className="shrink-0 pt-0.5" onClick={e => e.stopPropagation()}>
                              <Switch
                                checked={test.enabled}
                                onCheckedChange={v => { void handleToggleEnabled(test, v); }}
                                aria-label={test.enabled ? "Disable this flow" : "Enable this flow"}
                                className="scale-90"
                              />
                            </div>
                          </div>

                          {/* Bottom: issues + run count left, play + trash right */}
                          <div className="mt-auto flex items-end justify-between gap-2 text-[11px]">
                            <div className="min-w-0 space-y-0.5">
                              <span className={cn(
                                "font-medium tabular-nums block",
                                (test.issues_count ?? 0) > 0
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-muted-foreground/60",
                              )}>
                                {test.issues_count ?? 0} issue{(test.issues_count ?? 0) !== 1 ? "s" : ""}
                              </span>
                              <span className="text-muted-foreground/60 font-mono block">
                                {test.run_count != null && test.run_count > 0
                                  ? `${test.run_count} run${test.run_count !== 1 ? "s" : ""}`
                                  : relativeTime(test.created_at)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                onClick={() => navigate(`/tests/${test.id}`)}
                              >
                                View
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                disabled={running === test.id || !selectedEnvId || !test.enabled}
                                loading={running === test.id}
                                onClick={() => handleRunSaved(test)}
                                aria-label={`Run ${test.name}`}
                              >
                                {running !== test.id && <Play className="h-3.5 w-3.5" />}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteTarget(test)}
                                aria-label={`Delete ${test.name}`}
                              >
                                <Trash className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                  })}
                </div>
              </>
            )}
          </main>
        </div>
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
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Custom flow description
              </label>
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


