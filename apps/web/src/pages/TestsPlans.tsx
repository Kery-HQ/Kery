import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ListChecks, Plus, Play, MagnifyingGlassPlus, ArrowRight,
  DotsThree, FolderPlus, CaretDown, CaretRight, Pencil, Trash,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import {
  fetchEnvironments, fetchGroups, createGroup as apiCreateGroup,
  renameGroup as apiRenameGroup, deleteGroup as apiDeleteGroup,
  moveTestToGroup, runProjectTest, discoverFlows, fetchDiscoveryStatus,
  createTest, updateTest, deleteTest,
} from "@/projectApi";
import type { TestGroup } from "@/projectApi";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

type Env = { id: string; name: string; base_url: string; is_default: boolean };

type SavedTest = {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  context?: string | null;
  group_id?: string | null;
  created_at: string;
  issues_count?: number;
};

// ─── Main Page ───────────────────────────────────────────────────────────────

export const TestsPlans: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentProjectId } = useProject();

  const [environments, setEnvironments] = React.useState<Env[]>([]);
  const [quickEnvId, setQuickEnvId] = React.useState<string | null>(null);
  const [groupEnvIds, setGroupEnvIds] = React.useState<Record<string, string>>({});

  const [groups, setGroups] = React.useState<TestGroup[]>([]);
  const [tests, setTests] = React.useState<SavedTest[]>([]);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());

  const [discovering, setDiscovering] = React.useState(false);
  const [activeDiscoveryRunId, setActiveDiscoveryRunId] = React.useState<string | null>(null);

  const [adhocIntent, setAdhocIntent] = React.useState("");
  const [adhocRunning, setAdhocRunning] = React.useState(false);

  const [runningTest, setRunningTest] = React.useState<string | null>(null);
  const [runningGroup, setRunningGroup] = React.useState<string | null>(null);
  const [groupPages, setGroupPages] = React.useState<Record<string, number>>({});

  const PAGE_SIZE = 5;

  // Create / edit test
  const [testDialogOpen, setTestDialogOpen] = React.useState(false);
  const [editingTest, setEditingTest] = React.useState<SavedTest | null>(null);
  const [formName, setFormName] = React.useState("");
  const [formIntent, setFormIntent] = React.useState("");
  const [formContext, setFormContext] = React.useState("");
  const [formGroupId, setFormGroupId] = React.useState("");
  const [formSaving, setFormSaving] = React.useState(false);

  // Delete test
  const [deleteTestTarget, setDeleteTestTarget] = React.useState<SavedTest | null>(null);

  // Move test
  const [moveTestTarget, setMoveTestTarget] = React.useState<SavedTest | null>(null);
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false);

  // New group
  const [newGroupDialogOpen, setNewGroupDialogOpen] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState("");
  const [newGroupSaving, setNewGroupSaving] = React.useState(false);

  // Rename group
  const [renameGroupTarget, setRenameGroupTarget] = React.useState<TestGroup | null>(null);
  const [renameGroupValue, setRenameGroupValue] = React.useState("");
  const [renameGroupSaving, setRenameGroupSaving] = React.useState(false);

  // Delete group
  const [deleteGroupTarget, setDeleteGroupTarget] = React.useState<TestGroup | null>(null);
  const [deleteGroupWithTests, setDeleteGroupWithTests] = React.useState(false);
  const [deleteGroupBusy, setDeleteGroupBusy] = React.useState(false);

  // ─── Load ─────────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!currentProjectId) return;
    fetchEnvironments(currentProjectId).then((res) => {
      const envs: Env[] = res.environments || [];
      setEnvironments(envs);
      const def = envs.find((e) => e.is_default) || envs[0];
      if (def) setQuickEnvId(def.id);
    });
    loadGroups();
    setTestDialogOpen(false);
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

  async function loadGroups() {
    if (!currentProjectId) return;
    const res = await fetchGroups(currentProjectId);
    setGroups(res.groups || []);
    setTests((res.tests || []).filter(Boolean));
  }

  // Navigate when command palette selects a specific test.
  React.useEffect(() => {
    const id = (location.state as { selectTestId?: string } | null)?.selectTestId;
    if (!id || tests.length === 0) return;
    const match = tests.find((t) => t.id === id);
    if (match) navigate(`/tests/${match.id}`, { replace: true });
  }, [tests, location.state, navigate]);

  // ─── Computed ────────────────────────────────────────────────────────────

  const testsByGroup = React.useMemo(() => {
    const map = new Map<string, SavedTest[]>(groups.map((g) => [g.id, []]));
    const defaultGroup = groups.find((g) => g.is_default);
    for (const test of tests) {
      const gid = test.group_id;
      if (gid && map.has(gid)) {
        map.get(gid)!.push(test);
      } else if (defaultGroup) {
        map.get(defaultGroup.id)!.push(test);
      }
    }
    return map;
  }, [tests, groups]);

  const hasAnyTests = tests.length > 0;

  // ─── Env helpers ─────────────────────────────────────────────────────────

  function getGroupEnvId(groupId: string): string {
    return groupEnvIds[groupId] || quickEnvId || environments[0]?.id || "";
  }

  function setGroupEnvId(groupId: string, envId: string) {
    setGroupEnvIds((prev) => ({ ...prev, [groupId]: envId }));
  }

  // ─── Create / Edit Test ───────────────────────────────────────────────────

  function openCreateTest(groupId?: string) {
    setEditingTest(null);
    setFormName("");
    setFormIntent("");
    setFormContext("");
    setFormGroupId(groupId || groups.find((g) => g.is_default)?.id || "");
    setTestDialogOpen(true);
  }

  function openEditTest(test: SavedTest) {
    setEditingTest(test);
    setFormName(test.name);
    setFormIntent(test.intent);
    setFormContext(test.context ?? "");
    setFormGroupId(test.group_id || groups.find((g) => g.is_default)?.id || "");
    setTestDialogOpen(true);
  }

  async function handleSaveTest() {
    if (!currentProjectId || !formName.trim() || !formIntent.trim()) return;
    setFormSaving(true);
    try {
      if (editingTest) {
        const res = await updateTest(currentProjectId, editingTest.id, {
          name: formName.trim(),
          intent: formIntent.trim(),
          context: formContext.trim() || undefined,
        });
        setTests((prev) => prev.map((t) => (t.id === res.test.id ? { ...t, ...res.test } : t)));
      } else {
        const res = await createTest(currentProjectId, {
          name: formName.trim(),
          intent: formIntent.trim(),
          context: formContext.trim() || undefined,
          group_id: formGroupId || undefined,
        });
        setTests((prev) => [res.test, ...prev]);
        setGroups((prev) =>
          prev.map((g) => (g.id === res.test.group_id ? { ...g, test_count: g.test_count + 1 } : g)),
        );
      }
      setTestDialogOpen(false);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDeleteTest(test: SavedTest) {
    await deleteTest(test.project_id, test.id);
    setTests((prev) => prev.filter((t) => t.id !== test.id));
    setGroups((prev) =>
      prev.map((g) => (g.id === test.group_id ? { ...g, test_count: Math.max(0, g.test_count - 1) } : g)),
    );
    // Reset to page 1 for the affected group so we don't land on an empty page
    if (test.group_id) setGroupPages((p) => ({ ...p, [test.group_id!]: 1 }));
    setDeleteTestTarget(null);
  }

  // ─── Move Test ────────────────────────────────────────────────────────────

  async function handleMoveTest(targetGroupId: string) {
    if (!moveTestTarget || !currentProjectId) return;
    const prevGroupId = moveTestTarget.group_id;
    try {
      await moveTestToGroup(currentProjectId, moveTestTarget.id, targetGroupId);
      setTests((prev) =>
        prev.map((t) => (t.id === moveTestTarget.id ? { ...t, group_id: targetGroupId } : t)),
      );
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id === prevGroupId) return { ...g, test_count: Math.max(0, g.test_count - 1) };
          if (g.id === targetGroupId) return { ...g, test_count: g.test_count + 1 };
          return g;
        }),
      );
      toast.success("Test moved");
    } catch {
      toast.error("Failed to move test");
    }
    setMoveDialogOpen(false);
    setMoveTestTarget(null);
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  async function handleCreateGroup() {
    if (!currentProjectId || !newGroupName.trim()) return;
    setNewGroupSaving(true);
    try {
      const res = await apiCreateGroup(currentProjectId, newGroupName.trim());
      setGroups((prev) => [...prev, res.group]);
      setNewGroupName("");
      setNewGroupDialogOpen(false);
      toast.success("Group created");
    } finally {
      setNewGroupSaving(false);
    }
  }

  async function handleRenameGroup() {
    if (!currentProjectId || !renameGroupTarget || !renameGroupValue.trim()) return;
    setRenameGroupSaving(true);
    try {
      const res = await apiRenameGroup(currentProjectId, renameGroupTarget.id, renameGroupValue.trim());
      setGroups((prev) => prev.map((g) => (g.id === res.group.id ? res.group : g)));
      setRenameGroupTarget(null);
      toast.success("Group renamed");
    } finally {
      setRenameGroupSaving(false);
    }
  }

  async function handleDeleteGroup() {
    if (!currentProjectId || !deleteGroupTarget) return;
    setDeleteGroupBusy(true);
    try {
      await apiDeleteGroup(currentProjectId, deleteGroupTarget.id, deleteGroupWithTests);
      await loadGroups();
      setDeleteGroupTarget(null);
      setDeleteGroupWithTests(false);
      toast.success("Group deleted");
    } finally {
      setDeleteGroupBusy(false);
    }
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

  async function handleAdhocRun() {
    if (!currentProjectId || !quickEnvId || !adhocIntent.trim()) return;
    setAdhocRunning(true);
    try {
      await runProjectTest(currentProjectId, quickEnvId, adhocIntent.trim());
      toast.success("Run queued");
      setAdhocIntent("");
    } finally {
      setAdhocRunning(false);
    }
  }

  async function handleRunTest(test: SavedTest) {
    const envId = getGroupEnvId(test.group_id || "");
    if (!envId) return;
    setRunningTest(test.id);
    try {
      await runProjectTest(test.project_id, envId, "", test.id);
      toast.success("Run queued");
    } finally {
      setRunningTest(null);
    }
  }

  async function handleRunGroup(group: TestGroup) {
    const envId = getGroupEnvId(group.id);
    if (!envId || !currentProjectId) return;
    const groupTests = testsByGroup.get(group.id) || [];
    if (groupTests.length === 0) return;
    setRunningGroup(group.id);
    try {
      for (const t of groupTests) {
        await runProjectTest(t.project_id, envId, "", t.id);
      }
      toast.success(`${groupTests.length} run${groupTests.length !== 1 ? "s" : ""} queued`);
    } finally {
      setRunningGroup(null);
    }
  }

  async function handleDiscover() {
    if (activeDiscoveryRunId) {
      navigate(`/runs/${activeDiscoveryRunId}`);
      return;
    }
    if (!currentProjectId || !quickEnvId) return;
    setDiscovering(true);
    try {
      const { runId } = await discoverFlows(currentProjectId, quickEnvId);
      setActiveDiscoveryRunId(runId);
      navigate(`/runs/${runId}`);
    } catch {
      setDiscovering(false);
      toast.error("Discovery failed to start");
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<ListChecks className="h-4 w-4" />} title="Tests" />
        <EmptyState
          icon={<ListChecks className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view tests."
          className="flex-1"
        />
      </div>
    );
  }

  const canSaveTest = formName.trim().length > 0 && formIntent.trim().length > 0;

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<ListChecks className="h-4 w-4" />} title="Tests" />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-6 animate-page-enter">

          {/* ── #1 Quick Test ─────────────────────────────────────────── */}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-2">Quick Test</p>
            <div className="bg-card border rounded-xl px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Play className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                <input
                  value={adhocIntent}
                  onChange={(e) => setAdhocIntent(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && adhocIntent.trim()) void handleAdhocRun(); }}
                  placeholder="Describe what to test..."
                  className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/40 outline-none min-w-0"
                />
                {environments.length > 0 && (
                  <Select
                    value={quickEnvId ?? ""}
                    onChange={(e) => setQuickEnvId(e.target.value)}
                    className="w-[120px] h-8 text-[12px] shrink-0"
                  >
                    {environments.map((env) => (
                      <option key={env.id} value={env.id}>{env.name}</option>
                    ))}
                  </Select>
                )}
                <Button
                  onClick={() => void handleAdhocRun()}
                  disabled={adhocRunning || !adhocIntent.trim() || !quickEnvId}
                  loading={adhocRunning}
                  className="gap-1.5 shrink-0"
                >
                  {!adhocRunning && <Play className="h-3.5 w-3.5" />}
                  Run
                </Button>
              </div>
            </div>
          </div>

          {/* ── #2 Auto-scan banner ───────────────────────────────────── */}
          <div className={cn(
            "border rounded-xl px-5 py-4 flex items-center gap-4",
            !hasAnyTests ? "bg-primary/5 border-primary/20" : "bg-card",
          )}>
            <div className={cn(
              "h-9 w-9 rounded-lg flex items-center justify-center shrink-0",
              !hasAnyTests ? "bg-primary/15" : "bg-muted",
            )}>
              <MagnifyingGlassPlus className={cn("h-4 w-4", !hasAnyTests ? "text-primary" : "text-muted-foreground")} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-foreground">
                {discovering ? "Scanning your app for tests..." : "Auto-scan for tests"}
              </p>
              <p className="text-[12px] text-muted-foreground/70 mt-0.5">
                {discovering
                  ? "Kery is exploring your app. Discovered tests will be saved here when done."
                  : "Let Kery explore your app and automatically discover tests to save and rerun."}
              </p>
            </div>
            <Button
              variant={!hasAnyTests ? "default" : "outline"}
              disabled={!quickEnvId || discovering}
              loading={discovering}
              onClick={() => void handleDiscover()}
              className="gap-1.5 shrink-0"
            >
              {!discovering && <ArrowRight className="h-3.5 w-3.5" />}
              {discovering ? "Scanning..." : activeDiscoveryRunId ? "View Scan" : "Scan Now"}
            </Button>
          </div>

          {/* ── #3 / #4 / #5  Groups ─────────────────────────────────── */}
          <div className="space-y-5">
            {groups.length === 0 ? (
              <EmptyState
                icon={<ListChecks className="h-6 w-6" />}
                title="No tests yet"
                description="Run a quick test above, or scan your app to discover and save tests."
              />
            ) : (
              groups.map((group) => {
                const groupTests = testsByGroup.get(group.id) || [];
                const collapsed = collapsedGroups.has(group.id);
                const groupEnvId = getGroupEnvId(group.id);
                const isRunningGroup = runningGroup === group.id;
                const page = groupPages[group.id] ?? 1;
                const totalPages = Math.max(1, Math.ceil(groupTests.length / PAGE_SIZE));
                const pagedTests = groupTests.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

                return (
                  <div key={group.id}>
                    {/* Group header */}
                    <div className="flex items-center gap-2 h-8">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:text-foreground/80 transition-colors shrink-0"
                        onClick={() =>
                          setCollapsedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                      >
                        {collapsed
                          ? <CaretRight className="h-3 w-3 text-muted-foreground" />
                          : <CaretDown className="h-3 w-3 text-muted-foreground" />
                        }
                        <span>{group.name}</span>
                        <span className="text-[11px] text-muted-foreground/50 font-normal">({groupTests.length})</span>
                      </button>

                      <div className="flex-1 h-px bg-border" />

                      {/* Per-group credential selector */}
                      {environments.length > 0 && (
                        <Select
                          value={groupEnvId}
                          onChange={(e) => setGroupEnvId(group.id, e.target.value)}
                          className="w-[110px] h-7 text-[11px] shrink-0"
                        >
                          {environments.map((env) => (
                            <option key={env.id} value={env.id}>{env.name}</option>
                          ))}
                        </Select>
                      )}

                      {/* Run group */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 gap-1 text-[11px] text-muted-foreground hover:text-foreground shrink-0"
                        disabled={groupTests.length === 0 || !groupEnvId || isRunningGroup}
                        loading={isRunningGroup}
                        onClick={() => void handleRunGroup(group)}
                      >
                        {!isRunningGroup && <Play className="h-3 w-3" />}
                        Run group
                      </Button>

                      {/* Add test (not for auto-scan) */}
                      {!group.is_auto_scan && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 gap-1 text-[11px] text-muted-foreground hover:text-foreground shrink-0"
                          onClick={() => openCreateTest(group.id)}
                        >
                          <Plus className="h-3 w-3" />
                          Add test
                        </Button>
                      )}

                      {/* ⋯ menu (not for auto-scan) */}
                      {!group.is_auto_scan && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
                            >
                              <DotsThree className="h-4 w-4" weight="bold" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameGroupTarget(group);
                                setRenameGroupValue(group.name);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              Rename
                            </DropdownMenuItem>
                            {!group.is_default && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => {
                                    setDeleteGroupTarget(group);
                                    setDeleteGroupWithTests(false);
                                  }}
                                >
                                  <Trash className="h-3.5 w-3.5 mr-2" />
                                  Delete group
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>

                    {/* Test rows */}
                    {!collapsed && (
                      <div className="mt-1.5 space-y-1 pl-5">
                        {groupTests.length === 0 ? (
                          <p className="py-3 text-[12px] text-muted-foreground/50 text-center">
                            {group.is_auto_scan
                              ? "No tests discovered yet. Run a scan above."
                              : "No tests yet. Add one to get started."}
                          </p>
                        ) : (
                          <>
                            {pagedTests.map((test) => (
                              <div
                                key={test.id}
                                className="bg-card border rounded-lg px-3 py-2.5 flex items-center gap-3 group/row"
                              >
                                {/* Name + intent */}
                                <button
                                  type="button"
                                  onClick={() => navigate(`/tests/${test.id}`)}
                                  className="flex-1 min-w-0 text-left"
                                >
                                  <p className="text-[13px] font-medium text-foreground truncate">{test.name}</p>
                                  {test.intent && (
                                    <p className="text-[12px] text-muted-foreground/55 truncate mt-0.5">{test.intent}</p>
                                  )}
                                </button>

                                {/* Issues badge */}
                                {(test.issues_count ?? 0) > 0 && (
                                  <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium tabular-nums shrink-0">
                                    {test.issues_count} issue{test.issues_count !== 1 ? "s" : ""}
                                  </span>
                                )}

                                {/* Run */}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                  disabled={runningTest === test.id || !groupEnvId}
                                  loading={runningTest === test.id}
                                  onClick={() => void handleRunTest(test)}
                                >
                                  {runningTest !== test.id && <Play className="h-3.5 w-3.5" />}
                                </Button>

                                {/* ⋯ */}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity"
                                    >
                                      <DotsThree className="h-4 w-4" weight="bold" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-36">
                                    <DropdownMenuItem onClick={() => openEditTest(test)}>
                                      <Pencil className="h-3.5 w-3.5 mr-2" />
                                      Edit
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        setMoveTestTarget(test);
                                        setMoveDialogOpen(true);
                                      }}
                                    >
                                      Move to…
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="text-destructive focus:text-destructive"
                                      onClick={() => setDeleteTestTarget(test)}
                                    >
                                      <Trash className="h-3.5 w-3.5 mr-2" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            ))}

                            {/* Pagination */}
                            {totalPages > 1 && (
                              <div className="flex items-center justify-between pt-1">
                                <span className="text-[11px] text-muted-foreground/50 tabular-nums">
                                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, groupTests.length)} of {groupTests.length}
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                    disabled={page <= 1}
                                    onClick={() => setGroupPages((p) => ({ ...p, [group.id]: page - 1 }))}
                                  >
                                    Prev
                                  </Button>
                                  <span className="text-[11px] text-muted-foreground/50 tabular-nums px-1">
                                    {page} / {totalPages}
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                    disabled={page >= totalPages}
                                    onClick={() => setGroupPages((p) => ({ ...p, [group.id]: page + 1 }))}
                                  >
                                    Next
                                  </Button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* New group */}
            <div>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => { setNewGroupName(""); setNewGroupDialogOpen(true); }}
              >
                <FolderPlus className="h-3.5 w-3.5" />
                New group
              </Button>
            </div>
          </div>

        </div>
      </div>

      {/* ── Create / Edit Test Dialog ──────────────────────────────────── */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTest ? "Edit test" : "New test"}</DialogTitle>
            <DialogDescription>
              {editingTest ? "Update this test configuration." : "Define a new test for the agent to execute."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Name</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Checkout"
                autoFocus
                className="h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">What to test</label>
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
            {!editingTest && groups.filter((g) => !g.is_auto_scan).length > 1 && (
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Group</label>
                <Select
                  value={formGroupId}
                  onChange={(e) => setFormGroupId(e.target.value)}
                  className="h-8 text-[13px] w-full"
                >
                  {groups.filter((g) => !g.is_auto_scan).map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button size="sm" onClick={() => void handleSaveTest()} disabled={formSaving || !canSaveTest} loading={formSaving}>
              {editingTest ? "Save changes" : "Create test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Test Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!deleteTestTarget} onOpenChange={(open) => { if (!open) setDeleteTestTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete test</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTestTarget?.name}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteTestTarget && void handleDeleteTest(deleteTestTarget)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Move Test Dialog ───────────────────────────────────────────── */}
      <Dialog
        open={moveDialogOpen}
        onOpenChange={(open) => { if (!open) { setMoveDialogOpen(false); setMoveTestTarget(null); } }}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Move to group</DialogTitle>
            <DialogDescription>Select a group for "{moveTestTarget?.name}".</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-1">
            {groups
              .filter((g) => g.id !== moveTestTarget?.group_id)
              .map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="w-full text-left px-3 py-2 rounded-md text-[13px] hover:bg-accent transition-colors"
                  onClick={() => void handleMoveTest(g.id)}
                >
                  {g.name}
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── New Group Dialog ───────────────────────────────────────────── */}
      <Dialog open={newGroupDialogOpen} onOpenChange={setNewGroupDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
          </DialogHeader>
          <Input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newGroupName.trim()) void handleCreateGroup(); }}
            placeholder="Group name"
            autoFocus
            className="h-8 text-[13px]"
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void handleCreateGroup()}
              disabled={newGroupSaving || !newGroupName.trim()}
              loading={newGroupSaving}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename Group Dialog ────────────────────────────────────────── */}
      <Dialog open={!!renameGroupTarget} onOpenChange={(open) => { if (!open) setRenameGroupTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>
          <Input
            value={renameGroupValue}
            onChange={(e) => setRenameGroupValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && renameGroupValue.trim()) void handleRenameGroup(); }}
            autoFocus
            className="h-8 text-[13px]"
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void handleRenameGroup()}
              disabled={renameGroupSaving || !renameGroupValue.trim()}
              loading={renameGroupSaving}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Group Dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!deleteGroupTarget}
        onOpenChange={(open) => { if (!open) { setDeleteGroupTarget(null); setDeleteGroupWithTests(false); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete group</DialogTitle>
            <DialogDescription>
              Delete "{deleteGroupTarget?.name}"? Tests in this group will be moved to Default unless you choose to delete them.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={deleteGroupWithTests}
              onChange={(e) => setDeleteGroupWithTests(e.target.checked)}
              className="rounded border-border"
            />
            Also delete all tests in this group
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void handleDeleteGroup()}
              disabled={deleteGroupBusy}
              loading={deleteGroupBusy}
            >
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
