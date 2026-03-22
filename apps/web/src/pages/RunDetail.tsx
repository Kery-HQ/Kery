import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchRunBugs, getRunStreamUrl } from "../projectApi";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import {
  ArrowLeft, Clock, CheckCircle2, XCircle, Loader2,
  Brain, Keyboard, MousePointerClick, Navigation, Globe,
  Video, ChevronRight, Zap, LogIn,
  AlertCircle, Bug, Monitor, Eye, EyeOff, DollarSign, Server, Timer,
  Compass, Route,
} from "lucide-react";

// --- Types ---

type RunStep = {
  index: number;
  action: string;
  target?: string;
  value?: string;
  assertion?: string;
  reasoning?: string;
  url?: string;
  status: "ok" | "failed" | "skipped";
  error?: string;
  fromMemory: boolean;
  bugType?: "visual" | "functional" | "ux" | "other";
  severity?: "low" | "medium" | "high";
  at?: number;
  source?: "navigator" | "review" | "pathgen";
};

type LLMAgentType = "navigator" | "review" | "pathgen";

type LLMCallRecord = {
  seq: number;
  stepIndex: number;
  model: string;
  hasVision: boolean;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  costUsd: number;
  query?: string;
  imageBase64?: string;
  response: string;
  role?: "action" | "dom-scan";
  agent?: LLMAgentType;
};

type MemoryEntryBrief = {
  id?: string;
  type: string;
  summary: string;
  content: string;
  source?: string;
  confidence?: number;
};

type Run = {
  id: string;
  status: string;
  summary?: string;
  started_at?: string;
  completed_at?: string;
  trigger_ref?: string;
  video_url?: string;
  test_id?: string | null;
  environment?: string | null;
  project_id?: string | null;
  source_type?: "page" | "test" | "dashboard";
  source_label?: string;
  source_back_path?: string | null;
  steps_json?: RunStep[];
  memory_loaded?: MemoryEntryBrief[];
  bugs_json?: (RunStep & { source?: "navigator" | "review" | "network" | "pathgen" })[];
  llm_calls_json?: LLMCallRecord[];
};

type Tab = "overview" | "steps" | "llm" | "memory";

// --- Helpers ---

function duration(started?: string, completed?: string): string {
  if (!started || !completed) return "";
  const ms = new Date(completed).getTime() - new Date(started).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function statusVariant(status: string): "success" | "destructive" | "warning" | "neutral" {
  if (status === "passed")  return "success";
  if (status === "failed")  return "destructive";
  if (status === "running") return "warning";
  return "neutral";
}

function severityColor(severity?: string) {
  switch (severity) {
    case "high":   return "border-l-red-500 bg-card";
    case "medium": return "border-l-orange-400 bg-card";
    default:       return "border-l-amber-400 bg-card";
  }
}

const SEVERITY_DOT: Record<string, string> = {
  high:   "bg-red-500",
  medium: "bg-orange-400",
  low:    "bg-amber-400",
};

function formatCost(usd: number): string {
  if (usd === 0) return "$0.0000";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStepTime(at: number): string {
  const epochMs = Math.floor(at);
  const fracMs = (at % 1) * 1000;
  const ms = Math.floor(fracMs);
  const micros = Math.round((fracMs % 1) * 1000);
  const d = new Date(epochMs);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}.${ms.toString().padStart(3, "0")}${micros.toString().padStart(3, "0")}`;
}

function ActionIcon({ action }: { action: string }) {
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  switch (action) {
    case "fill":     return <Keyboard          className={cn(cls, "text-blue-500")} />;
    case "click":    return <MousePointerClick className={cn(cls, "text-emerald-500")} />;
    case "navigate": return <Navigation        className={cn(cls, "text-violet-500")} />;
    case "assert":   return <CheckCircle2      className={cn(cls, "text-amber-500")} />;
    case "auth":     return <LogIn             className={cn(cls, "text-cyan-500")} />;
    case "wait":     return <Timer             className={cn(cls, "text-slate-400")} />;
    case "bug":      return <Bug               className={cn(cls, "text-red-500")} />;
    case "done":     return <CheckCircle2      className={cn(cls, "text-emerald-500")} />;
    default:         return <Globe             className={cn(cls, "text-muted-foreground")} />;
  }
}


// --- Main component ---

export const RunDetail: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = React.useState<Run | null>(null);
  const [steps, setSteps] = React.useState<RunStep[]>([]);
  const [llmCalls, setLlmCalls] = React.useState<LLMCallRecord[]>([]);
  const [runBugs, setRunBugs] = React.useState<{ id?: string; name: string; description: string; url?: string | null }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [liveScreenshot, setLiveScreenshot] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");

  // --- SSE or polling ---

  React.useEffect(() => {
    if (!runId) return;

    let es: EventSource | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    async function initLoad() {
      let initialRun: Run | null = null;
      try {
        const res = await fetchRun(runId!);
        if (res.run) {
          initialRun = res.run;
          setRun(res.run);
          setSteps(res.run.steps_json ?? []);
          setLlmCalls(res.run.llm_calls_json ?? []);
          if (res.run.status !== "running") {
            fetchRunBugs(runId!).then((r) => setRunBugs(r.bugs ?? []));
          }
        }
      } finally {
        setLoading(false);
      }

      if (!initialRun || initialRun.status !== "running") return;

      const streamUrl = getRunStreamUrl(runId!);
      es = new EventSource(streamUrl);

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "step") {
            setSteps((prev) => [...prev, msg.step]);
          }
          if (msg.type === "screenshot") {
            setLiveScreenshot(msg.data);
          }
          if (msg.type === "llm_call") {
            setLlmCalls((prev) => [...prev, msg.call]);
          }
          if (msg.type === "done") {
            setRun(msg.run);
            setSteps(msg.run?.steps_json ?? []);
            setLlmCalls(msg.run?.llm_calls_json ?? []);
            setLiveScreenshot(null);
            if (msg.run?.id) fetchRunBugs(msg.run.id).then((r) => setRunBugs(r.bugs ?? []));
            es?.close();
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        es = null;
        pollInterval = setInterval(async () => {
          const res = await fetchRun(runId!);
          if (res.run) {
            setRun(res.run);
            setSteps(res.run.steps_json ?? []);
            setLlmCalls(res.run.llm_calls_json ?? []);
            if (res.run.status !== "running") {
              fetchRunBugs(runId!).then((r) => setRunBugs(r.bugs ?? []));
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            }
          }
        }, 4000);
      };
    }

    initLoad();

    return () => {
      es?.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [runId]);

  if (loading) {
    return (
      <div className="flex flex-col min-h-full">
        <Header runId={runId} onBack={() => navigate("/runs")} run={null} backUrl="/runs" />
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col min-h-full">
        <Header runId={runId} onBack={() => navigate("/runs")} run={null} backUrl="/runs" />
        <div className="flex items-center justify-center flex-1 text-muted-foreground text-[13px]">
          Run not found.
        </div>
      </div>
    );
  }

  const memoryLoaded        = run.memory_loaded ?? [];
  const bugsFound           = run.bugs_json ?? [];
  const okCount             = steps.filter(s => s.status === "ok" && s.action !== "bug").length;
  const failCount           = steps.filter(s => s.status === "failed").length;
  const totalCost           = llmCalls.reduce((sum, c) => sum + c.costUsd, 0);
  const memoryCount         = memoryLoaded.length;

  const tabs: { id: Tab; label: string; count?: number; badge?: string }[] = [
    { id: "overview", label: "Overview", badge: bugsFound.length > 0 ? String(bugsFound.length) : undefined },
    { id: "steps",    label: "Steps",    count: steps.length },
    { id: "llm",      label: "LLM",      count: llmCalls.length },
    { id: "memory",   label: "Memory",   count: memoryCount || undefined },
  ];

  const backUrl = run.project_id && run.source_back_path
    ? `/projects/${run.project_id}/${run.source_back_path}`
    : "/runs";

  return (
    <div className="flex flex-col min-h-full">
      <Header runId={run.id} onBack={() => navigate(backUrl)} run={run} backUrl={backUrl} />

      {/* Tab bar */}
      <div className="flex border-b border-border bg-card px-6 flex-shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium border-b-2 -mb-px transition-colors",
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400">
                {t.badge}
              </span>
            )}
            {t.count !== undefined && t.badge === undefined && (
              <span className="text-[11px] font-mono text-muted-foreground/50">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "overview" && (
          <OverviewTab
            run={run} steps={steps} bugsFound={bugsFound} runBugs={runBugs}
            liveScreenshot={liveScreenshot}
            okCount={okCount} failCount={failCount} memoryCount={memoryCount}
            totalCost={totalCost} llmCallCount={llmCalls.length}
          />
        )}
        {tab === "steps" && (
          <StepsTab steps={steps} run={run} liveScreenshot={liveScreenshot} />
        )}
        {tab === "llm" && (
          <LLMTab llmCalls={llmCalls} totalCost={totalCost} />
        )}
        {tab === "memory" && (
          <MemoryTab memoryLoaded={memoryLoaded} />
        )}
      </div>
    </div>
  );
};

// --- Overview tab ---

function OverviewTab({ run, steps, bugsFound, runBugs, liveScreenshot, okCount, failCount, memoryCount, totalCost, llmCallCount }: {
  run: Run; steps: RunStep[]; bugsFound: RunStep[]; runBugs: { id?: string; name: string; description: string; url?: string | null }[]; liveScreenshot: string | null;
  okCount: number; failCount: number; memoryCount: number;
  totalCost: number; llmCallCount: number;
}) {
  function isCreatedBug(found: any): boolean {
    const name = (found.name ?? "").trim();
    const desc = (found.description ?? found.reasoning ?? "").trim();
    const url = (found.url ?? "").trim();
    return runBugs.some(
      (b) =>
        (b.description.trim() === desc || b.name.trim() === name) &&
        (b.url ?? "").trim() === url
    );
  }
  return (
    <div className="px-8 py-6 max-w-4xl w-full mx-auto space-y-8 animate-fade-in">

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Steps"       value={String(steps.length)} />
        <StatCard label="Passed"      value={String(okCount)}       valueClass="text-emerald-500" />
        <StatCard label="Failed"      value={String(failCount)}     valueClass={failCount > 0 ? "text-destructive" : undefined} />
        <StatCard label="Issues"      value={String(bugsFound.length)} valueClass={bugsFound.length > 0 ? "text-orange-500" : undefined} />
        <StatCard label="LLM Cost"    value={formatCost(totalCost)} valueClass="text-violet-500" />
      </div>

      {/* Running status */}
      {run.status === "running" && (
        <div className="flex items-center gap-3 px-5 py-4 rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20">
          <Loader2 className="h-4 w-4 text-amber-500 animate-spin flex-shrink-0" />
          <span className="text-[13px] text-amber-700 dark:text-amber-400">
            Agent is running -- {steps.length} step{steps.length !== 1 ? "s" : ""} \u00b7 {llmCallCount} LLM call{llmCallCount !== 1 ? "s" : ""} \u00b7 {formatCost(totalCost)}
          </span>
        </div>
      )}

      {/* Live browser screenshot */}
      {run.status === "running" && liveScreenshot && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Live View</p>
            <span className="flex items-center gap-1.5 ml-1">
              <span className="h-1.5 w-1.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-semibold text-red-500">LIVE</span>
            </span>
          </div>
          <div className="rounded-lg border border-border bg-black overflow-hidden shadow-sm">
            <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="w-full block" />
          </div>
        </div>
      )}

      {/* Recording */}
      {run.video_url && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Video className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Recording</p>
          </div>
          <div className="rounded-lg border border-border bg-black overflow-hidden shadow-sm">
            <video src={run.video_url} controls className="w-full max-h-[480px]" preload="metadata" />
          </div>
        </div>
      )}

      {/* Issues */}
      {bugsFound.length > 0 && (
        <Section
          icon={<AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />}
          title="Issues Found"
          count={bugsFound.length}
          subtitle={
            runBugs.length < bugsFound.length
              ? `${runBugs.length} created, ${bugsFound.length - runBugs.length} skipped (duplicate)`
              : bugsFound.length > 0
                ? "All tracked"
                : undefined
          }
        >
          <div className="space-y-1.5">
            {bugsFound.map((bug: any, i: number) => {
              const title = bug.name ?? (bug.reasoning ? `${(bug.bugType ?? bug.category) ?? "Issue"} -- step ${bug.index}` : `Issue at step ${bug.index}`);
              const body = bug.description ?? bug.reasoning;
              const typeLabel = bug.category ?? bug.bugType;
              const created = isCreatedBug(bug);
              return (
                <div key={i} className={cn("flex items-start gap-3 px-4 py-3 rounded-lg border border-border border-l-[3px] text-[13px]", severityColor(bug.severity))}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", SEVERITY_DOT[bug.severity] ?? "bg-muted-foreground/30")} />
                      {typeLabel && <span className="text-[12px] font-medium text-foreground capitalize">{typeLabel}</span>}
                      {bug.source && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {bug.source === "review" && "Review Agent"}
                          {bug.source === "navigator" && "Navigator"}
                          {bug.source === "pathgen" && "Path Gen"}
                        </span>
                      )}
                      {bug.severity && (
                        <span className="text-[10px] text-muted-foreground/50 capitalize">{bug.severity}</span>
                      )}
                      <span className="text-[10px] font-mono text-muted-foreground/40 ml-auto">
                        step {bug.index ?? i + 1}
                        {created ? " \u00b7 tracked" : " \u00b7 skipped"}
                      </span>
                    </div>
                    <p className="text-[13px] text-foreground/90">{title}</p>
                    {body && body !== title && <p className="text-[12px] text-muted-foreground mt-0.5">{body}</p>}
                    {bug.url && <p className="text-[11px] font-mono text-muted-foreground/40 mt-0.5 truncate">{bug.url}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Summary */}
      {run.summary && (
        <Section icon={<AlertCircle className="h-3.5 w-3.5" />} title="Summary" subtitle="LLM-generated run summary">
          <div className="rounded-lg border border-border bg-card p-5 text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">
            {run.summary}
          </div>
        </Section>
      )}

      {steps.length === 0 && run.status !== "running" && (
        <Section icon={<ChevronRight className="h-3.5 w-3.5" />} title="Steps" subtitle="No step data recorded">
          <div className="rounded-lg border border-dashed border-border py-8 text-center">
            <p className="text-[13px] text-muted-foreground">No step details available.</p>
          </div>
        </Section>
      )}
    </div>
  );
}

// --- Steps tab ---

function StepsTab({ steps, run, liveScreenshot }: { steps: RunStep[]; run: Run; liveScreenshot: string | null }) {
  return (
    <div className="px-8 py-6 max-w-4xl w-full mx-auto space-y-6 animate-fade-in">

      {run.status === "running" && liveScreenshot && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Live View</p>
            <span className="flex items-center gap-1.5 ml-1">
              <span className="h-1.5 w-1.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-semibold text-red-500">LIVE</span>
            </span>
          </div>
          <div className="rounded-lg border border-border bg-black overflow-hidden shadow-sm">
            <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="w-full block" />
          </div>
        </div>
      )}

      {steps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          {run.status === "running"
            ? <><Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40 mx-auto mb-2" /><p className="text-[13px] text-muted-foreground">Waiting for first step...</p></>
            : <p className="text-[13px] text-muted-foreground">No steps recorded.</p>
          }
        </div>
      ) : (
        <div className="space-y-1.5">
          {steps.map((step, i) => <StepRow key={i} step={step} />)}
          {run.status === "running" && (
            <div className="flex items-center gap-2 px-4 py-3">
              <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin" />
              <span className="text-[12px] text-muted-foreground">Agent is working...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const LLM_AGENT_CONFIG: Record<LLMAgentType, { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }> = {
  navigator: { label: "Navigator", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800", Icon: Compass },
  review:     { label: "Review",   className: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-400 border-violet-200 dark:border-violet-800", Icon: Eye },
  pathgen:    { label: "Path Gen", className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-400 border-amber-200 dark:border-amber-800", Icon: Route },
};

// --- LLM tab ---

function LLMTab({ llmCalls, totalCost }: { llmCalls: LLMCallRecord[]; totalCost: number }) {
  const [agentFilter, setAgentFilter] = React.useState<LLMAgentType | "all">("all");
  const totalInput  = llmCalls.reduce((s, c) => s + c.inputTokens,  0);
  const totalOutput = llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalMs     = llmCalls.reduce((s, c) => s + c.durationMs,   0);
  const visionCalls = llmCalls.filter(c => c.hasVision).length;
  const scanCalls   = llmCalls.filter(c => c.role === "dom-scan").length;

  const filteredCalls = agentFilter === "all"
    ? llmCalls
    : llmCalls.filter((c) => (c.agent ?? "navigator") === agentFilter);

  const agentCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: llmCalls.length };
    for (const a of ["navigator", "review", "pathgen"] as const) {
      counts[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).length;
    }
    return counts;
  }, [llmCalls]);

  const agentCosts = React.useMemo(() => {
    const cost: Record<string, number> = {};
    for (const a of ["navigator", "review", "pathgen"] as const) {
      cost[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).reduce((s, c) => s + c.costUsd, 0);
    }
    return cost;
  }, [llmCalls]);

  const agentsWithCalls = (["navigator", "review", "pathgen"] as const).filter((a) => agentCounts[a] > 0);

  return (
    <div className="px-8 py-6 max-w-5xl w-full mx-auto space-y-6 animate-fade-in">

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Cost"    value={formatCost(totalCost)}        valueClass="text-violet-500" />
        <StatCard label="LLM Calls"     value={String(llmCalls.length)} />
        <StatCard label="Tokens In"     value={totalInput.toLocaleString()}  valueClass="text-blue-500" />
        <StatCard label="Tokens Out"    value={totalOutput.toLocaleString()} valueClass="text-emerald-500" />
      </div>

      {llmCalls.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <DollarSign className="h-6 w-6 text-muted-foreground/20 mx-auto mb-2" />
          <p className="text-[13px] text-muted-foreground">No LLM calls recorded yet.</p>
        </div>
      ) : (
        <>
          {/* Agent filter pills + per-agent cost */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setAgentFilter("all")}
              className={cn(
                "text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors",
                agentFilter === "all"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
              )}
            >
              All ({agentCounts.all})
            </button>
            {agentsWithCalls.map((a) => {
              const { label, Icon, className } = LLM_AGENT_CONFIG[a];
              return (
                <button
                  key={a}
                  onClick={() => setAgentFilter(a)}
                  className={cn(
                    "text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1",
                    agentFilter === a ? className : "bg-muted/30 border-border hover:bg-muted/50"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label} ({agentCounts[a]})
                </button>
              );
            })}
          </div>
          {agentsWithCalls.length > 1 && (
            <p className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3">
              {agentsWithCalls.map((a) => {
                const { label } = LLM_AGENT_CONFIG[a];
                return (
                  <span key={a}>
                    <span className="font-medium text-foreground/80">{label}:</span> {formatCost(agentCosts[a])} ({agentCounts[a]} calls)
                  </span>
                );
              })}
            </p>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
            <span>Vision: <span className="text-foreground font-medium">{visionCalls}</span></span>
            <span>Text-only: <span className="text-foreground font-medium">{llmCalls.length - visionCalls - scanCalls}</span></span>
            {scanCalls > 0 && (
              <span>DOM scans: <span className="text-foreground font-medium">{scanCalls}</span></span>
            )}
            <span>Total time: <span className="text-foreground font-medium">{formatMs(totalMs)}</span></span>
            <span className="text-[10px] opacity-50 ml-auto">Pricing: input/output per 1M tokens (USD)</span>
          </div>

          {/* Call table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
            {/* Header */}
            <div className="grid grid-cols-[2rem_3rem_1fr_5rem_5rem_5rem_4rem_4rem] gap-x-3 px-4 py-2 border-b border-border bg-muted/40">
              {["#", "Step", "Model", "Role", "Tokens In", "Tokens Out", "Cost", "Time"].map(h => (
                <span key={h} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{h}</span>
              ))}
            </div>
            {/* Rows */}
            <div className="divide-y divide-border">
              {filteredCalls.map((call) => <LLMCallRow key={call.seq} call={call} agentConfig={LLM_AGENT_CONFIG} />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LLMCallRow({ call, agentConfig }: { call: LLMCallRecord; agentConfig: typeof LLM_AGENT_CONFIG }) {
  const [expanded, setExpanded] = React.useState(false);
  const isScan = call.role === "dom-scan";
  const agent = call.agent ?? "navigator";
  const agentInfo = agentConfig[agent];

  return (
    <div className={cn(
      isScan && "bg-sky-50/40 dark:bg-sky-950/10",
      agent === "navigator" && "border-l-2 border-l-emerald-400/50",
      agent === "review" && "border-l-2 border-l-violet-400/50",
      agent === "pathgen" && "border-l-2 border-l-amber-400/50"
    )}>
      <button
        className="w-full grid grid-cols-[2rem_3rem_1fr_5rem_5rem_5rem_4rem_4rem] gap-x-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors items-center"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[11px] font-mono text-muted-foreground/50 tabular-nums">{call.seq}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{call.stepIndex}</span>
        <span className="text-[11px] text-foreground truncate flex items-center gap-1.5">
          {agentInfo && (
            <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0 flex items-center gap-0.5", agentInfo.className)}>
              <agentInfo.Icon className="h-3 w-3" />
              {agentInfo.label}
            </span>
          )}
          <span className="truncate">{call.model}</span>
        </span>
        <span className="flex items-center gap-1">
          {isScan ? (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400">
              dom-scan
            </span>
          ) : (
            <>
              {call.hasVision
                ? <Eye className="h-3.5 w-3.5 text-violet-500" />
                : <EyeOff className="h-3.5 w-3.5 text-muted-foreground/30" />
              }
              {call.attempt > 1 && (
                <span className="ml-1 text-[10px] text-amber-500 font-medium">\u00d7{call.attempt}</span>
              )}
            </>
          )}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-blue-500">{call.inputTokens.toLocaleString()}</span>
        <span className="text-[11px] font-mono tabular-nums text-emerald-500">{call.outputTokens.toLocaleString()}</span>
        <span className="text-[11px] font-mono tabular-nums text-violet-500">{formatCost(call.costUsd)}</span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{formatMs(call.durationMs)}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50 space-y-3">
          {/* Screenshot sent to LLM */}
          {call.imageBase64 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5 mt-3">Screenshot (sent to LLM)</p>
              <div className="rounded border border-border bg-black overflow-hidden">
                <img
                  src={`data:image/jpeg;base64,${call.imageBase64}`}
                  alt="Screenshot sent to LLM"
                  className="w-full block max-h-64 object-contain object-top"
                />
              </div>
            </div>
          )}
          {/* Query */}
          {call.query && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Query</p>
              <pre className="text-[11px] font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/80 max-h-48">
                {call.query}
              </pre>
            </div>
          )}
          {/* Response */}
          {call.response && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Response</p>
              <pre className="text-[11px] font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/80">
                {call.response}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Memory tab ---

function MemoryTab({ memoryLoaded }: { memoryLoaded: MemoryEntryBrief[] }) {
  return (
    <div className="px-8 py-6 max-w-4xl w-full mx-auto space-y-8 animate-fade-in">

      {memoryLoaded.length > 0 && (
        <Section icon={<Brain className="h-3.5 w-3.5" />} title="Memory Loaded" count={memoryLoaded.length} subtitle="Semantic memory entries loaded for this run">
          <div className="divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
            {memoryLoaded.map((e, i) => (
              <div key={e.id ?? i} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border text-violet-600 bg-violet-50 border-violet-200 dark:bg-violet-950/20 dark:border-violet-900/30">
                    {e.type.replace(/_/g, " ")}
                  </span>
                  {e.source && (
                    <span className="text-[10px] text-muted-foreground/60">{e.source}</span>
                  )}
                  {e.confidence != null && (
                    <span className="text-[10px] font-mono text-muted-foreground/50 ml-auto">{e.confidence}%</span>
                  )}
                </div>
                <p className="text-[12px] font-medium text-foreground mt-1">{e.summary}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{e.content}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {memoryLoaded.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <Brain className="h-6 w-6 text-muted-foreground/20 mx-auto mb-2" />
          <p className="text-[13px] text-muted-foreground">No memory data for this run.</p>
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

function Header({ runId, onBack, run, backUrl }: { runId?: string; onBack: () => void; run: Run | null; backUrl: string }) {
  return (
    <div className="flex items-center gap-3 px-8 h-14 border-b border-border bg-card flex-shrink-0 flex-wrap">
      <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors" title={backUrl !== "/runs" ? `Back to ${run?.source_label ?? "source"}` : "Back to runs"}>
        <ArrowLeft className="h-4 w-4" />
      </button>
      <span className="text-muted-foreground/40">/</span>
      <span className="font-mono text-[12px] text-muted-foreground">{runId?.slice(0, 8)}</span>
      {run && (
        <>
          {run.source_label && run.source_back_path && backUrl !== "/runs" && (
            <>
              <span className="text-muted-foreground/40">\u00b7</span>
              <span className="text-[11px] text-muted-foreground">Started from</span>
              <a
                href={backUrl}
                onClick={(e) => { e.preventDefault(); onBack(); }}
                className="text-[11px] text-primary hover:underline font-medium"
              >
                {run.source_label}
              </a>
            </>
          )}
          <Badge variant={statusVariant(run.status)} className="ml-1">{run.status}</Badge>
          {duration(run.started_at, run.completed_at) && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground ml-1">
              <Clock className="h-3 w-3" />
              {duration(run.started_at, run.completed_at)}
            </span>
          )}
          {run.environment && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground ml-1" title="Environment">
              <Server className="h-3 w-3" />
              {run.environment}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function Section({ icon, title, count, subtitle, children }: {
  icon: React.ReactNode; title: string; count?: number; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{title}</p>
        {count !== undefined && <span className="text-[11px] font-mono text-muted-foreground/50">{count}</span>}
        {subtitle && <span className="text-[11px] text-muted-foreground/40 ml-1">-- {subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">{label}</p>
      <p className={cn("text-xl font-semibold tabular-nums", valueClass ?? "text-foreground")}>{value}</p>
    </div>
  );
}


function StepRow({ step }: { step: RunStep }) {
  const [expanded, setExpanded] = React.useState(false);
  const isBug = step.action === "bug";

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden transition-colors",
      isBug
        ? cn("border-border border-l-[3px] bg-card", step.severity === "high" ? "border-l-red-500" : step.severity === "medium" ? "border-l-orange-400" : "border-l-amber-400")
        : step.status === "failed"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card",
    )}>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40 transition-colors"
        onClick={() => step.reasoning || step.error ? setExpanded(!expanded) : undefined}
      >
        <span className="text-[11px] font-mono text-muted-foreground/40 w-6 flex-shrink-0 tabular-nums text-right">
          {step.index}
        </span>
        {step.at != null && (
          <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums flex-shrink-0" title="Step time">
            {formatStepTime(step.at)}
          </span>
        )}
        <ActionIcon action={step.action} />
        <span className={cn(
          "text-[12px] font-mono font-medium flex-shrink-0",
          isBug ? "text-red-500" : step.status === "failed" ? "text-destructive" : "text-foreground",
        )}>
          {step.action}
        </span>
        {isBug ? (
          <span className="flex items-center gap-1.5 flex-1 min-w-0">
            {step.source && (
              <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                {step.source === "review" && "Review"}
                {step.source === "navigator" && "Nav"}
                {step.source === "pathgen" && "Path"}
              </span>
            )}
            {step.bugType && (
              <span className="text-[10px] text-muted-foreground/50 flex-shrink-0 capitalize">
                {step.bugType} \u00b7 {step.severity ?? "?"}
              </span>
            )}
            {step.reasoning && <span className="text-[12px] text-muted-foreground truncate">{step.reasoning}</span>}
          </span>
        ) : (
          step.target && (
            <span className="text-[11px] font-mono text-muted-foreground truncate flex-1 min-w-0">
              \u2192 {step.target}
              {step.value && <span className="text-foreground"> = &quot;{step.value}&quot;</span>}
              {step.assertion && <span className="text-amber-600"> assert &quot;{step.assertion}&quot;</span>}
            </span>
          )
        )}
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          {step.fromMemory && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded px-1.5 py-0.5">
              <Zap className="h-2.5 w-2.5" />
              memory
            </span>
          )}
          {!isBug && step.status === "ok"     && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
          {step.status === "failed"            && <XCircle      className="h-3.5 w-3.5 text-destructive flex-shrink-0" />}
        </div>
      </button>
      {expanded && (step.reasoning || step.error || step.url) && (
        <div className="px-4 pb-3 pt-0 border-t border-border/50 space-y-1.5">
          {step.url && <p className="text-[11px] font-mono text-muted-foreground/60 truncate">{step.url}</p>}
          {step.reasoning && !isBug && <p className="text-[12px] text-muted-foreground">{step.reasoning}</p>}
          {step.error && (
            <p className="text-[11px] font-mono text-destructive bg-destructive/5 rounded px-2 py-1">\u2717 {step.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
