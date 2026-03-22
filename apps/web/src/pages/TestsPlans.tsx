import React from "react";
import { useNavigate } from "react-router-dom";
import {
  FlaskConical, Plus, ChevronRight, Play, Pencil, Trash2, Check, X,
  Brain, Keyboard, MousePointerClick, Navigation, Globe,
  Repeat, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select } from "../components/ui/select";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { RunList } from "../components/RunList";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import {
  fetchEnvironments, fetchTests, createTest, updateTest, deleteTest,
  runProjectTest, fetchProjectRuns, fetchTestMemory,
} from "../projectApi";

type RegressionStep = {
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
  save_screenshots?: boolean;
  max_steps?: number | null;
  created_at: string;
  run_count?: number;
  regression_plan?: RegressionStep[] | null;
  plan_status?: "none" | "ready" | "stale" | null;
  plan_success_count?: number;
};

type MemoryFact = { selector: string; purpose: string; action: string; hits: number };

export const TestsPlans: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();

  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);

  const [tests, setTests] = React.useState<SavedTest[]>([]);
  const [selectedTest, setSelectedTest] = React.useState<SavedTest | null>(null);
  const [adhocActive, setAdhocActive] = React.useState(false);
  const [testTab, setTestTab] = React.useState<"runs" | "script" | "memory" | "details">("runs");

  // Create / edit form
  const [showForm, setShowForm] = React.useState(false);
  const [editing, setEditing] = React.useState<SavedTest | null>(null);
  const [formName, setFormName] = React.useState("");
  const [formIntent, setFormIntent] = React.useState("");
  const [formContext, setFormContext] = React.useState("");
  const [formSaveScreenshots, setFormSaveScreenshots] = React.useState(false);
  const [formMaxSteps, setFormMaxSteps] = React.useState<string>("");
  const [formSaving, setFormSaving] = React.useState(false);

  // Adhoc
  const [adhocIntent, setAdhocIntent] = React.useState("test login then create a new order");
  const [adhocRunning, setAdhocRunning] = React.useState(false);

  // Memory
  const [testMemory, setTestMemory] = React.useState<MemoryFact[]>([]);
  const [memoryLoading, setMemoryLoading] = React.useState(false);

  const [running, setRunning] = React.useState<string | null>(null);

  // ─── Init ────────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!currentProjectId) return;
    fetchEnvironments(currentProjectId).then((res) => {
      const envs = res.environments || [];
      setEnvironments(envs);
      setSelectedEnvId(envs[0]?.id || null);
    });
    loadTests();
    setSelectedTest(null);
    setShowForm(false);
  }, [currentProjectId]);

  async function loadTests() {
    if (!currentProjectId) return;
    const res = await fetchTests(currentProjectId);
    setTests((res.tests || []).filter(Boolean));
  }

  // ─── Test memory ──────────────────────────────────────────────────────────

  async function loadTestMemoryFn(test: SavedTest) {
    setMemoryLoading(true);
    try {
      const res = await fetchTestMemory(test.project_id, test.id);
      const entries = res.entries || [];
      setTestMemory(entries.map((e: any) => ({
        selector: e.summary,
        purpose: e.content,
        action: e.type,
        hits: e.confidence ?? 50,
      })));
    } finally {
      setMemoryLoading(false);
    }
  }

  async function handleClearTestMemory() {
    setTestMemory([]);
  }

  async function handleDeleteTestMemoryFact(_selector: string, _action: string) {
    // No-op: test memory is now project-level
  }

  // ─── Select / tab ──────────────────────────────────────────────────────────

  function selectTest(test: SavedTest) {
    setSelectedTest(test);
    setAdhocActive(false);
    setTestTab("runs");
    setShowForm(false);
    setEditing(null);
  }

  function openAdhoc() {
    setAdhocActive(true);
    setSelectedTest(null);
    setShowForm(false);
  }

  function handleSelectTestTab(newTab: "runs" | "script" | "memory" | "details") {
    setTestTab(newTab);
    if (newTab === "memory" && selectedTest) loadTestMemoryFn(selectedTest);
  }

  // ─── Create / Edit ────────────────────────────────────────────────────────

  function openCreate() {
    setEditing(null);
    setFormName(""); setFormIntent(""); setFormContext(""); setFormSaveScreenshots(false); setFormMaxSteps("");
    setShowForm(true);
    setSelectedTest(null);
    setAdhocActive(false);
  }

  function openEdit(test: SavedTest) {
    setEditing(test);
    setFormName(test.name);
    setFormIntent(test.intent);
    setFormContext(test.context ?? "");
    setFormSaveScreenshots(test.save_screenshots ?? false);
    setFormMaxSteps(test.max_steps != null ? String(test.max_steps) : "");
    setShowForm(true);
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
          save_screenshots: formSaveScreenshots,
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
          save_screenshots: formSaveScreenshots,
          max_steps: parsedMaxSteps,
        });
        setTests((prev) => [res.test, ...prev]);
        setSelectedTest(res.test);
      }
      setShowForm(false);
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDelete(test: SavedTest) {
    if (!confirm(`Delete test flow "${test.name}"?`)) return;
    await deleteTest(test.project_id, test.id);
    setTests((prev) => prev.filter((t) => t.id !== test.id));
    if (selectedTest?.id === test.id) setSelectedTest(null);
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

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

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Flows</span>
          {tests.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground ml-1">{tests.length}</span>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: saved test flows + Run ad hoc */}
        <div className="w-72 flex-shrink-0 border-r border-border flex flex-col">
          <div className="p-4 border-b border-border">
            <Button size="sm" onClick={openCreate} className="w-full gap-1.5" disabled={!currentProjectId}>
              <Plus className="h-3.5 w-3.5" />
              New test flow
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!currentProjectId ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[13px] text-muted-foreground">Select a project first</p>
              </div>
            ) : tests.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <FlaskConical className="h-5 w-5 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-[13px] text-muted-foreground">No saved test flows yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {tests.map((test) => (
                  <button
                    key={test.id}
                    onClick={() => selectTest(test)}
                    className={cn(
                      "group w-full flex flex-col items-stretch gap-1 px-4 py-3 text-left transition-all duration-150",
                      selectedTest?.id === test.id && !adhocActive ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={cn(
                        "h-1.5 w-1.5 rounded-full flex-shrink-0 transition-colors",
                        selectedTest?.id === test.id && !adhocActive ? "bg-primary" : "bg-muted-foreground/30",
                      )} />
                      <span className="flex-1 text-[13px] font-medium text-foreground truncate">{test.name}</span>
                      {test.plan_status === "ready" && (
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 flex-shrink-0" title={`Regression script ready (${test.plan_success_count ?? 0} runs)`}>
                          Script
                        </span>
                      )}
                      {test.plan_status === "stale" && (
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 flex-shrink-0" title="Regression script needs refresh">
                          Stale
                        </span>
                      )}
                      <ChevronRight className={cn(
                        "h-3.5 w-3.5 flex-shrink-0 transition-all",
                        selectedTest?.id === test.id && !adhocActive ? "text-muted-foreground" : "text-muted-foreground/20 group-hover:text-muted-foreground/40",
                      )} />
                    </div>
                    {test.intent && (
                      <p className="text-[11px] text-muted-foreground truncate pl-4 pr-1" title={test.intent}>
                        {test.intent.trim().replace(/\s+/g, " ").slice(0, 48)}
                        {(test.intent.trim().replace(/\s+/g, " ").length > 48) ? "…" : ""}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-border p-3">
            <button
              type="button"
              onClick={openAdhoc}
              className={cn(
                "w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[12px] font-medium transition-colors",
                adhocActive ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
            >
              <Play className="h-3.5 w-3.5" />
              Run ad hoc
            </button>
          </div>
        </div>

        {/* Right: form / flow detail / ad hoc / empty */}
        <div className="flex-1 overflow-y-auto flex flex-col">
          {showForm ? (
            <TestForm
              editing={editing}
              name={formName} intent={formIntent} context={formContext}
              saveScreenshots={formSaveScreenshots} maxSteps={formMaxSteps}
              onName={setFormName} onIntent={setFormIntent} onContext={setFormContext}
              onSaveScreenshots={setFormSaveScreenshots} onMaxSteps={setFormMaxSteps}
              onSave={handleSaveForm} onCancel={() => { setShowForm(false); setEditing(null); }}
              saving={formSaving}
            />
          ) : adhocActive ? (
            <AdhocView
              intent={adhocIntent}
              onIntent={setAdhocIntent}
              environments={environments}
              selectedEnvId={selectedEnvId}
              onEnvChange={setSelectedEnvId}
              onRun={handleAdhocRun}
              running={adhocRunning}
              currentProjectId={currentProjectId}
            />
          ) : selectedTest ? (
            <TestDetail
              test={selectedTest}
              tab={testTab}
              onTab={handleSelectTestTab}
              memory={testMemory}
              memoryLoading={memoryLoading}
              running={running === selectedTest.id}
              environments={environments}
              selectedEnvId={selectedEnvId}
              onEnvChange={setSelectedEnvId}
              onRun={() => handleRunSaved(selectedTest)}
              onEdit={() => openEdit(selectedTest)}
              onDelete={() => handleDelete(selectedTest)}
              onClearMemory={handleClearTestMemory}
              onDeleteFact={handleDeleteTestMemoryFact}
              currentProjectId={currentProjectId}
            />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
              <FlaskConical className="h-8 w-8 text-muted-foreground/20 mb-3" />
              <p className="text-[13px] text-muted-foreground">Select a test flow or create a new one</p>
              <p className="text-[12px] text-muted-foreground/70 mt-1">Or use Run ad hoc to execute a one-off intent</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── AdhocView ───────────────────────────────────────────────────────────────

function AdhocView({
  intent, onIntent, environments, selectedEnvId, onEnvChange, onRun, running, currentProjectId,
}: {
  intent: string; onIntent: (v: string) => void;
  environments: any[]; selectedEnvId: string | null; onEnvChange: (id: string) => void;
  onRun: () => void; running: boolean; currentProjectId: string | null;
}) {
  return (
    <div className="px-8 py-6 animate-fade-in max-w-2xl">
      <h2 className="text-[15px] font-semibold text-foreground mb-2">Ad hoc run</h2>
      <p className="text-[12px] text-muted-foreground mb-6">
        Run a one-off test without saving it. The agent will execute your intent and you can view results in the run history.
      </p>
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div>
              <label htmlFor="adhoc-intent" className="text-[12px] font-medium text-foreground/80 mb-1.5 block">Intent</label>
              <Textarea
                id="adhoc-intent"
                value={intent}
                onChange={(e) => onIntent(e.target.value)}
                rows={5}
                placeholder="Describe what the agent should do…"
                className="min-h-[120px] resize-y"
              />
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {environments.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-muted-foreground font-medium">Environment</span>
                  <Select
                    value={selectedEnvId ?? ""}
                    onChange={(e) => onEnvChange(e.target.value)}
                    className="w-[180px] h-8 text-[12px] py-1"
                  >
                    {environments.map((env) => (
                      <option key={env.id} value={env.id}>{env.name}</option>
                    ))}
                  </Select>
                </div>
              )}
              <Button
                onClick={onRun}
                disabled={running || !intent.trim() || !selectedEnvId || !currentProjectId}
                className="gap-2"
              >
                <Play className="h-3.5 w-3.5" />
                {running ? "Starting…" : "Run now"}
              </Button>
            </div>
            {environments.length === 0 && (
              <p className="text-[12px] text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                Add an environment in the Environments page to enable running.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── TestForm ─────────────────────────────────────────────────────────────────

function TestForm({ editing, name, intent, context, saveScreenshots, maxSteps, onName, onIntent, onContext, onSaveScreenshots, onMaxSteps, onSave, onCancel, saving }: {
  editing: SavedTest | null;
  name: string; intent: string; context: string; saveScreenshots: boolean; maxSteps: string;
  onName: (v: string) => void; onIntent: (v: string) => void; onContext: (v: string) => void;
  onSaveScreenshots: (v: boolean) => void; onMaxSteps: (v: string) => void;
  onSave: () => void; onCancel: () => void; saving: boolean;
}) {
  const canSave = name.trim().length > 0 && intent.trim().length > 0;
  return (
    <div className="px-8 py-6 animate-fade-in max-w-2xl">
      <h2 className="text-[15px] font-semibold text-foreground mb-6">
        {editing ? "Edit test flow" : "Create new test flow"}
      </h2>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Basic info</p>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div>
            <label htmlFor="test-name" className="text-[12px] font-medium text-foreground/80 mb-1.5 block">Name</label>
            <Input
              id="test-name"
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="e.g. Checkout flow"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="test-intent" className="text-[12px] font-medium text-foreground/80 mb-1.5 block">Intent</label>
            <Textarea
              id="test-intent"
              value={intent}
              onChange={(e) => onIntent(e.target.value)}
              rows={4}
              placeholder="Describe what the agent should do…"
              className="min-h-[100px] resize-y"
            />
          </div>
          <div>
            <label htmlFor="test-context" className="text-[12px] font-medium text-foreground/80 mb-1.5 block">
              Context <span className="text-muted-foreground/60 font-normal">(optional)</span>
            </label>
            <Textarea
              id="test-context"
              value={context}
              onChange={(e) => onContext(e.target.value)}
              rows={4}
              placeholder="Expected behaviors, known bug-prone areas, what to check…"
              className="min-h-[100px] resize-y"
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground/60">Injected into the agent prompt to guide bug detection.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardContent className="pt-4 pb-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-foreground">Save screenshots</p>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">Store the browser screenshot for each LLM call. Increases run storage size.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={saveScreenshots}
              onClick={() => onSaveScreenshots(!saveScreenshots)}
              className={cn(
                "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                saveScreenshots ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200",
                  saveScreenshots ? "translate-x-4" : "translate-x-0",
                )}
              />
            </button>
          </div>
          <div className="border-t border-border pt-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-foreground">
                Max steps <span className="text-muted-foreground/60 font-normal text-[11px]">(optional)</span>
              </p>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">Override the default 50-step limit for this flow. Maximum 250.</p>
            </div>
            <Input
              type="number"
              min={1}
              max={250}
              value={maxSteps}
              onChange={(e) => onMaxSteps(e.target.value)}
              placeholder="50"
              className="w-20 h-8 text-[12px] text-right"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving || !canSave} className="gap-1.5">
          <Check className="h-3.5 w-3.5" />
          {saving ? "Saving…" : editing ? "Save changes" : "Create test flow"}
        </Button>
        <Button variant="ghost" onClick={onCancel} className="gap-1.5">
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── TestDetail ───────────────────────────────────────────────────────────────

function TestDetail({
  test, tab, onTab, memory, memoryLoading, running,
  environments, selectedEnvId, onEnvChange,
  onRun, onEdit, onDelete, onClearMemory, onDeleteFact, currentProjectId,
}: {
  test: SavedTest; tab: "runs" | "script" | "memory" | "details"; onTab: (t: "runs" | "script" | "memory" | "details") => void;
  memory: MemoryFact[]; memoryLoading: boolean; running: boolean;
  environments: any[]; selectedEnvId: string | null; onEnvChange: (id: string) => void;
  onRun: () => void; onEdit: () => void; onDelete: () => void;
  onClearMemory: () => void; onDeleteFact: (s: string, a: string) => void;
  currentProjectId: string | null;
}) {
  const [flowRuns, setFlowRuns] = React.useState<any[]>([]);
  const [runsLoading, setRunsLoading] = React.useState(false);
  const canRun = !!selectedEnvId;

  React.useEffect(() => {
    if (tab !== "runs" || !currentProjectId) return;
    setRunsLoading(true);
    fetchProjectRuns(currentProjectId)
      .then((res) => {
        const runs = (res.runs ?? []).filter((r: any) => r.test_id === test.id);
        setFlowRuns(runs);
      })
      .finally(() => setRunsLoading(false));
  }, [tab, currentProjectId, test.id]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 py-5 border-b border-border bg-card/50">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-foreground truncate">{test.name}</h2>
            <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{test.id.slice(0, 12)}…</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {environments.length > 0 && (
              <Select
                value={selectedEnvId ?? ""}
                onChange={(e) => onEnvChange(e.target.value)}
                className="w-[160px] h-8 text-[12px] py-1"
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </Select>
            )}
            <Button size="sm" onClick={onRun} disabled={running || !canRun} className="gap-1.5 h-7 text-[12px]"
              title={!canRun ? "Select an environment first" : undefined}>
              <Play className="h-3 w-3" />
              {running ? "Starting…" : "Run"}
            </Button>
          </div>
        </div>
        <div className="flex gap-0.5 mt-4">
          {(["runs", "script", "memory", "details"] as const).map((t) => (
            <button key={t} onClick={() => onTab(t)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors flex items-center gap-1",
                tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
            >
              {t === "script" ? "Script" : t.charAt(0).toUpperCase() + t.slice(1)}
              {t === "script" && test.plan_status === "ready" && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 max-w-3xl mx-auto w-full">
        {tab === "runs" && (
          <div className="animate-fade-in">
            <RunList
              runs={flowRuns}
              title="Runs for this test flow"
              loading={runsLoading}
              emptyMessage="No runs yet. Use Run above to execute this flow."
            />
          </div>
        )}

        {tab === "script" && (
          <ScriptTab plan={test.regression_plan} planStatus={test.plan_status} successCount={test.plan_success_count} />
        )}

        {tab === "details" && (
          <div className="space-y-6 animate-fade-in max-w-2xl mx-auto">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onEdit} className="gap-1.5 h-7 text-[12px]">
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={onDelete}
                className="gap-1.5 h-7 text-[12px] text-destructive border-destructive/50 hover:bg-destructive/10">
                <Trash2 className="h-3 w-3" /> Delete
              </Button>
            </div>
            <Card>
              <CardHeader className="pb-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Intent</p>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="rounded-md bg-muted/40 p-4 text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{test.intent}</div>
              </CardContent>
            </Card>
            {test.context ? (
              <Card>
                <CardHeader className="pb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Context</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="rounded-md bg-muted/40 p-4 text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">{test.context}</div>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center">
                  <p className="text-[13px] text-muted-foreground">No context set</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">Edit this test flow to add expected behaviors or known bug-prone areas.</p>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="pt-4 pb-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">Save screenshots</p>
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">Store the browser screenshot for each LLM call</p>
                  </div>
                  <span className={cn(
                    "text-[11px] font-semibold px-2.5 py-1 rounded-full",
                    test.save_screenshots
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground",
                  )}>
                    {test.save_screenshots ? "On" : "Off"}
                  </span>
                </div>
                <div className="border-t border-border pt-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">Max steps</p>
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">Step budget for this flow</p>
                  </div>
                  <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-muted text-muted-foreground tabular-nums">
                    {test.max_steps ?? 50}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "memory" && (
          <div className="space-y-4 animate-fade-in max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 px-0.5">
                Flow memory {memory.length > 0 && <span className="ml-1 text-muted-foreground/40">({memory.length})</span>}
              </p>
              {memory.length > 0 && (
                <Button size="sm" variant="ghost" onClick={onClearMemory}
                  className="gap-1.5 h-7 text-[12px] text-destructive hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-3 w-3" /> Clear all
                </Button>
              )}
            </div>
            {memoryLoading ? (
              <Card><CardContent className="py-12 text-center"><p className="text-[13px] text-muted-foreground">Loading…</p></CardContent></Card>
            ) : memory.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Brain className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-[13px] text-muted-foreground">No test memory yet</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">Memory is populated when you run this flow.</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="divide-y divide-border">
                  {memory.map((fact, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-accent/30 transition-colors">
                      <MemIcon action={fact.action} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] text-foreground truncate">{fact.purpose}</p>
                        <p className="text-[11px] font-mono text-muted-foreground truncate">{fact.selector}</p>
                      </div>
                      <span className="text-[11px] font-mono text-muted-foreground/50 tabular-nums">{fact.hits}×</span>
                      <button onClick={() => onDeleteFact(fact.selector, fact.action)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemIcon({ action }: { action: string }) {
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  if (action === "fill")     return <Keyboard          className={cn(cls, "text-blue-500/70")} />;
  if (action === "click")    return <MousePointerClick className={cn(cls, "text-emerald-500/70")} />;
  if (action === "navigate") return <Navigation        className={cn(cls, "text-violet-500/70")} />;
  return <Globe className={cn(cls, "text-muted-foreground/50")} />;
}

// ─── Script Tab (Regression Plan Viewer) ──────────────────────────────────────

function ScriptTab({ plan, planStatus, successCount }: {
  plan?: RegressionStep[] | null;
  planStatus?: string | null;
  successCount?: number;
}) {
  const status = planStatus ?? "none";
  const steps = plan ?? [];

  return (
    <div className="space-y-5 animate-fade-in max-w-2xl mx-auto">
      {/* Status header */}
      <div className="flex items-center gap-3">
        {status === "ready" ? (
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Regression script active
          </span>
        ) : status === "stale" ? (
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Script stale — will regenerate on next passing run
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Repeat className="h-3.5 w-3.5" />
            No regression script yet
          </span>
        )}
        {(successCount ?? 0) > 0 && (
          <span className="text-[11px] text-muted-foreground/50 ml-auto">
            {successCount} successful replay{successCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {status === "none" || steps.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Repeat className="h-6 w-6 text-muted-foreground/20 mx-auto mb-3" />
            <p className="text-[13px] text-muted-foreground">No script generated yet</p>
            <p className="text-[11px] text-muted-foreground/60 mt-1">
              Run this flow successfully and a deterministic Playwright script will be compiled automatically.
              Subsequent runs replay the script without LLM calls.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            {steps.length} step{steps.length !== 1 ? "s" : ""} · Pure Playwright replay (no LLM calls)
            {status === "ready" && " · Self-heals via Stagehand when selectors break"}
          </p>
          <RegressionPlanView steps={steps} />
        </>
      )}
    </div>
  );
}

// ─── Shared Regression Plan Step Viewer ────────────────────────────────────────

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
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  if (action === "fill")          return <Keyboard          className={cn(cls, "text-blue-500")} />;
  if (action === "click")         return <MousePointerClick className={cn(cls, "text-emerald-500")} />;
  if (action === "navigate")      return <Navigation        className={cn(cls, "text-violet-500")} />;
  if (action === "assert")        return <CheckCircle2      className={cn(cls, "text-amber-500")} />;
  return <Globe className={cn(cls, "text-muted-foreground/50")} />;
}

export function RegressionPlanView({ steps }: { steps: RegressionStep[] }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {steps.map((step, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-3 px-4 py-2.5 text-[12px]",
            i > 0 && "border-t border-border",
          )}
        >
          <span className="text-[10px] font-mono text-muted-foreground/40 w-5 flex-shrink-0 tabular-nums text-right pt-0.5">
            {i + 1}
          </span>
          <StepActionIcon action={step.action} />
          <div className="flex-1 min-w-0">
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
