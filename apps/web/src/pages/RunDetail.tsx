import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchRunBugs, getRunStreamUrl, stopRun } from "@/projectApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  statusVariant,
  duration,
  formatCost,
  formatMs,
} from "@/lib/formatters";
import {
  Activity,
  ArrowLeft,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Brain,
  Keyboard,
  MousePointerClick,
  Navigation,
  Globe,
  Video,
  ChevronDown,
  ChevronRight,
  Zap,
  LogIn,
  AlertCircle,
  Bug,
  Monitor,
  Eye,
  EyeOff,
  DollarSign,
  Server,
  Timer,
  Compass,
  Route,
  ExternalLink,
  Hash,
  FileText,
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
  screenshot?: string;
  stepsToReproduce?: string[];
  name?: string;
  description?: string;
  category?: string;
};

type LLMAgentType = "navigator" | "review" | "pathgen" | "summary";

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

function severityBorder(severity?: string) {
  switch (severity) {
    case "high":   return "border-l-red-500";
    case "medium": return "border-l-amber-500";
    default:       return "border-l-muted-foreground/30";
  }
}

function formatStepTime(at: number): string {
  const epochMs = Math.floor(at);
  const d = new Date(epochMs);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function ActionIcon({ action }: { action: string }) {
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  switch (action) {
    case "fill":     return <Keyboard          className={cn(cls, "text-blue-400")} />;
    case "click":    return <MousePointerClick className={cn(cls, "text-emerald-400")} />;
    case "navigate": return <Navigation        className={cn(cls, "text-violet-400")} />;
    case "assert":   return <CheckCircle2      className={cn(cls, "text-amber-400")} />;
    case "auth":     return <LogIn             className={cn(cls, "text-cyan-400")} />;
    case "wait":     return <Timer             className={cn(cls, "text-muted-foreground")} />;
    case "bug":      return <Bug               className={cn(cls, "text-red-400")} />;
    case "done":     return <CheckCircle2      className={cn(cls, "text-emerald-400")} />;
    default:         return <Globe             className={cn(cls, "text-muted-foreground")} />;
  }
}

function badgeVariantForStatus(status: string): "success" | "destructive" | "warning" | "neutral" | "running" {
  if (status === "running") return "running";
  return statusVariant(status);
}

const LLM_AGENT_CONFIG: Record<LLMAgentType, { label: string; color: string; Icon: React.ComponentType<{ className?: string }> }> = {
  navigator: { label: "Navigator", color: "text-emerald-400", Icon: Compass },
  review:    { label: "Review",    color: "text-violet-400",  Icon: Eye },
  pathgen:   { label: "Path Gen",  color: "text-amber-400",   Icon: Route },
  summary:   { label: "Summary",   color: "text-sky-400",     Icon: FileText },
};

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
  const [stopping, setStopping] = React.useState(false);

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
            fetchRunBugs(runId!).then((r: any) => setRunBugs(r.bugs ?? []));
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
            if (msg.run?.id) fetchRunBugs(msg.run.id).then((r: any) => setRunBugs(r.bugs ?? []));
            es?.close();
          }
        } catch { /* ignore parse errors */ }
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
              fetchRunBugs(runId!).then((r: any) => setRunBugs(r.bugs ?? []));
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

  // --- Loading skeleton ---

  if (loading) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Activity className="h-4 w-4" />} title="Run">
          <Skeleton className="h-5 w-16" />
        </PageHeader>
        <div className="px-6 py-6 space-y-4 animate-fade-in">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  // --- Not found ---

  if (!run) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Activity className="h-4 w-4" />} title="Run" />
        <EmptyState
          icon={<AlertCircle className="h-6 w-6" />}
          title="Run not found"
          description="This run may have been deleted or the ID is invalid."
          action={{ label: "Back to Runs", onClick: () => navigate("/runs") }}
        />
      </div>
    );
  }

  const memoryLoaded = run.memory_loaded ?? [];
  const bugsFound    = run.bugs_json ?? [];
  const totalCost    = llmCalls.reduce((sum, c) => sum + c.costUsd, 0);

  const backUrl = run.project_id && run.source_back_path
    ? `/projects/${run.project_id}/${run.source_back_path}`
    : "/runs";

  return (
    <div className="flex flex-col min-h-full">
      {/* Back + breadcrumb + PageHeader */}
      <PageHeader
        icon={<Activity className="h-4 w-4" />}
        title={`Run ${run.id.slice(0, 8)}`}
      >
        <Badge variant={badgeVariantForStatus(run.status)} dot>
          {run.status}
        </Badge>
        {run.status === "running" && (
          <>
            <Loader2 className="h-3.5 w-3.5 text-status-running animate-spin" />
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-[11px] px-2.5"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                await stopRun(run.id).catch(() => {});
              }}
            >
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          </>
        )}
      </PageHeader>

      {/* Breadcrumb bar */}
      <div className="flex items-center gap-2 px-6 h-9 border-b border-border bg-card/30 text-[11px] flex-shrink-0">
        <button
          onClick={() => navigate(backUrl)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          <span>
            {backUrl !== "/runs" && run.source_label
              ? run.source_label
              : "Runs"}
          </span>
        </button>
        <span className="text-muted-foreground/30">/</span>
        <span className="font-mono text-muted-foreground">{run.id.slice(0, 8)}</span>
      </div>

      {/* Radix Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex flex-col flex-1 min-h-0">
        <div className="px-6 flex-shrink-0 bg-card/50">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="overview" className="gap-1.5">
              Overview
              {bugsFound.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
                  {bugsFound.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="steps" className="gap-1.5">
              Steps
              <span className="text-[11px] font-mono text-muted-foreground/50">{steps.length}</span>
            </TabsTrigger>
            <TabsTrigger value="llm" className="gap-1.5">
              LLM Calls
              <span className="text-[11px] font-mono text-muted-foreground/50">{llmCalls.length}</span>
            </TabsTrigger>
            <TabsTrigger value="memory" className="gap-1.5">
              Memory
              {memoryLoaded.length > 0 && (
                <span className="text-[11px] font-mono text-muted-foreground/50">{memoryLoaded.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 overflow-y-auto">
          <TabsContent value="overview" className="mt-0">
            <OverviewTab
              run={run}
              steps={steps}
              bugsFound={bugsFound}
              runBugs={runBugs}
              liveScreenshot={liveScreenshot}
              llmCalls={llmCalls}
              totalCost={totalCost}
            />
          </TabsContent>

          <TabsContent value="steps" className="mt-0">
            <StepsTab steps={steps} run={run} liveScreenshot={liveScreenshot} />
          </TabsContent>

          <TabsContent value="llm" className="mt-0">
            <LLMTab llmCalls={llmCalls} totalCost={totalCost} />
          </TabsContent>

          <TabsContent value="memory" className="mt-0">
            <MemoryTab memoryLoaded={memoryLoaded} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

// ============================================================
// Overview tab
// ============================================================

function OverviewTab({
  run, steps, bugsFound, runBugs, liveScreenshot, llmCalls, totalCost,
}: {
  run: Run;
  steps: RunStep[];
  bugsFound: RunStep[];
  runBugs: { id?: string; name: string; description: string; url?: string | null }[];
  liveScreenshot: string | null;
  llmCalls: LLMCallRecord[];
  totalCost: number;
}) {
  const okCount   = steps.filter((s) => s.status === "ok" && s.action !== "bug").length;
  const failCount = steps.filter((s) => s.status === "failed").length;

  return (
    <div className="px-6 py-5 max-w-4xl w-full mx-auto space-y-6 animate-fade-in">

      {/* Running banner */}
      {run.status === "running" && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-status-running/20 bg-status-running/5">
          <Loader2 className="h-4 w-4 text-status-running animate-spin flex-shrink-0" />
          <span className="text-[13px] text-status-running">
            Running -- {steps.length} step{steps.length !== 1 ? "s" : ""} -- {llmCalls.length} LLM call{llmCalls.length !== 1 ? "s" : ""} -- {formatCost(totalCost)}
          </span>
        </div>
      )}

      {/* Summary */}
      {run.summary && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] text-foreground/90 leading-relaxed whitespace-pre-wrap">{run.summary}</p>
          </CardContent>
        </Card>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <MetricCard label="Duration" value={duration(run.started_at, run.completed_at) || "--"} mono />
        <MetricCard label="Steps" value={String(steps.length)} sub={`${okCount} ok / ${failCount} fail`} />
        <MetricCard label="Bugs" value={String(bugsFound.length)} variant={bugsFound.length > 0 ? "destructive" : undefined} />
        <MetricCard label="LLM Cost" value={formatCost(totalCost)} mono />
        <MetricCard label="LLM Calls" value={String(llmCalls.length)} />
      </div>

      {/* Detail metadata */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <MetaRow label="Status">
            <Badge variant={badgeVariantForStatus(run.status)} dot>{run.status}</Badge>
          </MetaRow>
          <MetaRow label="Started">
            <span className="font-mono text-[12px] text-foreground">
              {run.started_at ? new Date(run.started_at).toLocaleString() : "--"}
            </span>
          </MetaRow>
          <MetaRow label="Completed">
            <span className="font-mono text-[12px] text-foreground">
              {run.completed_at ? new Date(run.completed_at).toLocaleString() : "--"}
            </span>
          </MetaRow>
          {run.environment && (
            <MetaRow label="Environment">
              <span className="flex items-center gap-1.5 text-[12px]">
                <Server className="h-3 w-3 text-muted-foreground" />
                {run.environment}
              </span>
            </MetaRow>
          )}
          {run.video_url && (
            <MetaRow label="Recording">
              <a
                href={run.video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[12px] text-primary hover:underline"
              >
                <Video className="h-3 w-3" />
                View recording
                <ExternalLink className="h-3 w-3" />
              </a>
            </MetaRow>
          )}
        </CardContent>
      </Card>

      {/* Live screenshot */}
      {run.status === "running" && liveScreenshot && (
        <div>
          <SectionLabel icon={<Monitor className="h-3.5 w-3.5" />} text="Live View">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wider">Live</span>
            </span>
          </SectionLabel>
          <div className="rounded-lg border border-border bg-black overflow-hidden">
            <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="w-full block" />
          </div>
        </div>
      )}

      {/* Video player */}
      {run.video_url && (
        <div>
          <SectionLabel icon={<Video className="h-3.5 w-3.5" />} text="Recording" />
          <div className="rounded-lg border border-border bg-black overflow-hidden">
            <video src={run.video_url} controls className="w-full max-h-[480px]" preload="metadata" />
          </div>
        </div>
      )}

      {/* Bugs found */}
      {bugsFound.length > 0 && (
        <div>
          <SectionLabel
            icon={<AlertCircle className="h-3.5 w-3.5" />}
            text={`Issues Found (${bugsFound.length})`}
          />
          <div className="space-y-2">
            {bugsFound.map((bug: any, i: number) => (
              <BugCard key={i} bug={bug} index={i} runBugs={runBugs} />
            ))}
          </div>
        </div>
      )}

      {/* Empty steps hint */}
      {steps.length === 0 && run.status !== "running" && (
        <EmptyState
          icon={<ChevronRight className="h-5 w-5" />}
          title="No steps recorded"
          description="This run completed without any step data."
        />
      )}
    </div>
  );
}

// ============================================================
// Bug card (expandable, severity border)
// ============================================================

function BugCard({
  bug,
  index,
  runBugs,
}: {
  bug: any;
  index: number;
  runBugs: { id?: string; name: string; description: string; url?: string | null }[];
}) {
  const [expanded, setExpanded] = React.useState(false);

  const title = bug.name ?? (bug.reasoning
    ? `${(bug.bugType ?? bug.category) ?? "Issue"} -- step ${bug.index}`
    : `Issue at step ${bug.index}`);
  const body  = bug.description ?? bug.reasoning;
  const typeLabel = bug.category ?? bug.bugType;

  const isTracked = runBugs.some(
    (b) =>
      (b.description.trim() === (body ?? "").trim() || b.name.trim() === (bug.name ?? "").trim()) &&
      (b.url ?? "").trim() === (bug.url ?? "").trim()
  );

  return (
    <Card className={cn("border-l-[3px] overflow-hidden", severityBorder(bug.severity))}>
      <button
        className="w-full text-left px-4 py-3 hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded
            ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          }
          <StatusDot status={bug.severity === "high" ? "failed" : bug.severity === "medium" ? "warning" : "partial"} />
          {typeLabel && (
            <span className="text-[11px] font-medium text-foreground capitalize">{typeLabel}</span>
          )}
          {bug.severity && (
            <span className="text-[10px] text-muted-foreground capitalize">{bug.severity}</span>
          )}
          <span className="text-[10px] font-mono text-muted-foreground/50 ml-auto tabular-nums">
            step {bug.index ?? index + 1}
          </span>
          {bug.source && (
            <span className="text-[10px] text-muted-foreground/50">
              {bug.source === "review" ? "Review" : bug.source === "navigator" ? "Nav" : bug.source === "pathgen" ? "Path" : bug.source}
            </span>
          )}
          <Badge variant={isTracked ? "success" : "neutral"} className="text-[10px] ml-1">
            {isTracked ? "tracked" : "skipped"}
          </Badge>
        </div>
        <p className="text-[13px] text-foreground/90 mt-1.5 ml-5">{title}</p>
        {body && body !== title && (
          <p className="text-[12px] text-muted-foreground mt-0.5 ml-5 line-clamp-2">{body}</p>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50 space-y-3 ml-5">
          {bug.url && (
            <p className="text-[11px] font-mono text-muted-foreground/60 truncate pt-3">{bug.url}</p>
          )}

          {/* Steps to reproduce */}
          {bug.stepsToReproduce && bug.stepsToReproduce.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Steps to Reproduce</p>
              <ol className="list-decimal list-inside space-y-0.5">
                {bug.stepsToReproduce.map((s: string, j: number) => (
                  <li key={j} className="text-[12px] text-foreground/80">{s}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Screenshot */}
          {bug.screenshot && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Screenshot</p>
              <div className="rounded border border-border bg-black overflow-hidden">
                <img
                  src={bug.screenshot.startsWith("data:") ? bug.screenshot : `data:image/png;base64,${bug.screenshot}`}
                  alt="Bug screenshot"
                  className="w-full block max-h-64 object-contain object-top"
                />
              </div>
            </div>
          )}

          {/* Full step JSON */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Raw Data</p>
            <pre className="text-[11px] font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-48">
              {JSON.stringify(bug, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Steps tab -- vertical timeline
// ============================================================

function StepsTab({ steps, run, liveScreenshot }: { steps: RunStep[]; run: Run; liveScreenshot: string | null }) {
  return (
    <div className="px-6 py-5 max-w-4xl w-full mx-auto space-y-4 animate-fade-in">

      {/* Live screenshot */}
      {run.status === "running" && liveScreenshot && (
        <div className="mb-4">
          <SectionLabel icon={<Monitor className="h-3.5 w-3.5" />} text="Live View">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wider">Live</span>
            </span>
          </SectionLabel>
          <div className="rounded-lg border border-border bg-black overflow-hidden">
            <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="w-full block" />
          </div>
        </div>
      )}

      {steps.length === 0 ? (
        run.status === "running" ? (
          <div className="flex flex-col items-center py-12 gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            <p className="text-[13px] text-muted-foreground">Waiting for first step...</p>
          </div>
        ) : (
          <EmptyState
            icon={<Hash className="h-5 w-5" />}
            title="No steps recorded"
            description="This run has no step data."
          />
        )
      ) : (
        /* Vertical timeline */
        <div className="relative">
          {/* Connecting line */}
          <div className="absolute left-[19px] top-3 bottom-3 w-px bg-border" />

          <div className="space-y-0">
            {steps.map((step, i) => (
              <StepTimelineRow key={i} step={step} isLast={i === steps.length - 1 && run.status !== "running"} />
            ))}

            {/* Running indicator at end */}
            {run.status === "running" && (
              <div className="relative flex items-center gap-3 pl-2 py-2">
                <div className="relative z-10 flex items-center justify-center h-[22px] w-[22px]">
                  <Loader2 className="h-3.5 w-3.5 text-status-running animate-spin" />
                </div>
                <span className="text-[12px] text-muted-foreground">Agent is working...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StepTimelineRow({ step, isLast }: { step: RunStep; isLast: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const isBug   = step.action === "bug";
  const hasDetail = !!(step.reasoning || step.error || step.url);

  return (
    <div className="relative">
      <button
        className={cn(
          "w-full flex items-center gap-3 pl-2 pr-3 py-2 text-left transition-colors rounded-md",
          hasDetail && "hover:bg-accent/30 cursor-pointer",
          !hasDetail && "cursor-default",
        )}
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        {/* Index circle on timeline */}
        <div className={cn(
          "relative z-10 flex items-center justify-center h-[22px] w-[22px] rounded-full text-[10px] font-mono font-medium flex-shrink-0 border",
          isBug
            ? "border-red-500/40 bg-red-500/10 text-red-400"
            : step.status === "failed"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : step.status === "ok"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-border bg-card text-muted-foreground",
        )}>
          {step.index}
        </div>

        {/* Icon + action */}
        <ActionIcon action={step.action} />
        <span className={cn(
          "text-[12px] font-mono font-medium flex-shrink-0 w-16",
          isBug ? "text-red-400" : step.status === "failed" ? "text-destructive" : "text-foreground",
        )}>
          {step.action}
        </span>

        {/* Description */}
        <span className="flex-1 min-w-0 truncate text-[12px] text-muted-foreground">
          {isBug ? (
            <>
              {step.bugType && <span className="capitalize">{step.bugType}</span>}
              {step.severity && <span className="ml-1 capitalize text-muted-foreground/60">({step.severity})</span>}
              {step.reasoning && <span className="ml-1.5">{step.reasoning}</span>}
            </>
          ) : (
            <>
              {step.target && (
                <>
                  <span className="font-mono">{step.target}</span>
                  {step.value && <span className="text-foreground/80"> = "{step.value}"</span>}
                  {step.assertion && <span className="text-amber-400"> assert "{step.assertion}"</span>}
                </>
              )}
            </>
          )}
        </span>

        {/* URL */}
        {step.url && !isBug && (
          <span className="text-[10px] font-mono text-muted-foreground/40 truncate max-w-[140px] hidden sm:inline flex-shrink-0">
            {step.url.replace(/^https?:\/\//, "")}
          </span>
        )}

        {/* Right side: memory badge, status, duration */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          {step.fromMemory && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
              <Zap className="h-2.5 w-2.5" />
              memory
            </span>
          )}
          {step.at != null && (
            <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums hidden sm:inline">
              {formatStepTime(step.at)}
            </span>
          )}
          {!isBug && step.status === "ok"  && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {step.status === "failed"         && <XCircle className="h-3.5 w-3.5 text-destructive" />}
          {hasDetail && (
            expanded
              ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="ml-[34px] mr-3 mb-2 px-3 py-2.5 rounded-md bg-muted/30 border border-border/50 space-y-1.5">
          {step.url && (
            <p className="text-[11px] font-mono text-muted-foreground/60 truncate">{step.url}</p>
          )}
          {step.reasoning && !isBug && (
            <p className="text-[12px] text-muted-foreground">{step.reasoning}</p>
          )}
          {step.error && (
            <p className="text-[11px] font-mono text-destructive bg-destructive/5 rounded px-2 py-1">
              {step.error}
            </p>
          )}
          <details className="mt-2">
            <summary className="text-[10px] text-muted-foreground/50 cursor-pointer hover:text-muted-foreground">
              Raw JSON
            </summary>
            <pre className="text-[10px] font-mono text-muted-foreground/60 mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
              {JSON.stringify(step, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ============================================================
// LLM Calls tab
// ============================================================

function LLMTab({ llmCalls, totalCost }: { llmCalls: LLMCallRecord[]; totalCost: number }) {
  const [agentFilter, setAgentFilter] = React.useState<LLMAgentType | "all">("all");

  const totalInput  = llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutput = llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalMs     = llmCalls.reduce((s, c) => s + c.durationMs, 0);
  const visionCalls = llmCalls.filter((c) => c.hasVision).length;
  const scanCalls   = llmCalls.filter((c) => c.role === "dom-scan").length;

  const filteredCalls = agentFilter === "all"
    ? llmCalls
    : llmCalls.filter((c) => (c.agent ?? "navigator") === agentFilter);

  const agentCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: llmCalls.length };
    for (const a of ["navigator", "review", "pathgen", "summary"] as const) {
      counts[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).length;
    }
    return counts;
  }, [llmCalls]);

  const agentCosts = React.useMemo(() => {
    const cost: Record<string, number> = {};
    for (const a of ["navigator", "review", "pathgen", "summary"] as const) {
      cost[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).reduce((s, c) => s + c.costUsd, 0);
    }
    return cost;
  }, [llmCalls]);

  const agentsWithCalls = (["navigator", "review", "pathgen", "summary"] as const).filter((a) => agentCounts[a] > 0);

  return (
    <div className="px-6 py-5 max-w-5xl w-full mx-auto space-y-4 animate-fade-in">

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total Cost" value={formatCost(totalCost)} mono variant="primary" />
        <MetricCard label="Calls" value={String(llmCalls.length)} />
        <MetricCard label="Tokens In" value={totalInput.toLocaleString()} mono />
        <MetricCard label="Tokens Out" value={totalOutput.toLocaleString()} mono />
      </div>

      {llmCalls.length === 0 ? (
        <EmptyState
          icon={<DollarSign className="h-5 w-5" />}
          title="No LLM calls"
          description="No LLM calls have been recorded for this run yet."
        />
      ) : (
        <>
          {/* Agent filter pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setAgentFilter("all")}
              className={cn(
                "text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors",
                agentFilter === "all"
                  ? "bg-primary/10 text-primary border-primary/30"
                  : "bg-transparent text-muted-foreground border-border hover:bg-accent/40",
              )}
            >
              All ({agentCounts.all})
            </button>
            {agentsWithCalls.map((a) => {
              const { label, Icon, color } = LLM_AGENT_CONFIG[a];
              return (
                <button
                  key={a}
                  onClick={() => setAgentFilter(a)}
                  className={cn(
                    "text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1",
                    agentFilter === a
                      ? "bg-accent text-foreground border-border"
                      : "bg-transparent text-muted-foreground border-border hover:bg-accent/40",
                  )}
                >
                  <Icon className={cn("h-3 w-3", color)} />
                  {label} ({agentCounts[a]})
                </button>
              );
            })}
          </div>

          {/* Per-agent cost breakdown */}
          {agentsWithCalls.length > 1 && (
            <div className="flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
              {agentsWithCalls.map((a) => {
                const { label } = LLM_AGENT_CONFIG[a];
                return (
                  <span key={a}>
                    <span className="font-medium text-foreground/70">{label}:</span>{" "}
                    <span className="font-mono">{formatCost(agentCosts[a])}</span>{" "}
                    <span className="text-muted-foreground/50">({agentCounts[a]} calls)</span>
                  </span>
                );
              })}
            </div>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
            <span>Vision: <span className="font-mono text-foreground/70">{visionCalls}</span></span>
            <span>Text: <span className="font-mono text-foreground/70">{llmCalls.length - visionCalls - scanCalls}</span></span>
            {scanCalls > 0 && (
              <span>DOM scans: <span className="font-mono text-foreground/70">{scanCalls}</span></span>
            )}
            <span>Total time: <span className="font-mono text-foreground/70">{formatMs(totalMs)}</span></span>
          </div>

          <Separator />

          {/* Call list */}
          <div className="space-y-1">
            {filteredCalls.map((call) => (
              <LLMCallRow key={call.seq} call={call} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LLMCallRow({ call }: { call: LLMCallRecord }) {
  const [expanded, setExpanded] = React.useState(false);
  const isScan = call.role === "dom-scan";
  const agent  = call.agent ?? "navigator";
  const agentInfo = LLM_AGENT_CONFIG[agent];

  return (
    <Card className={cn(
      "overflow-hidden transition-colors",
      agent === "navigator" && "border-l-2 border-l-emerald-500/30",
      agent === "review"    && "border-l-2 border-l-violet-500/30",
      agent === "pathgen"   && "border-l-2 border-l-amber-500/30",
      agent === "summary"   && "border-l-2 border-l-sky-500/30",
    )}>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Seq */}
        <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums w-5 text-right flex-shrink-0">
          {call.seq}
        </span>

        {/* Step */}
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums w-8 flex-shrink-0">
          s{call.stepIndex}
        </span>

        {/* Agent badge */}
        {agentInfo && (
          <span className={cn("text-[10px] font-medium flex items-center gap-0.5 flex-shrink-0", agentInfo.color)}>
            <agentInfo.Icon className="h-3 w-3" />
            {agentInfo.label}
          </span>
        )}

        {/* Model */}
        <span className="text-[11px] text-foreground truncate flex-1 min-w-0">{call.model}</span>

        {/* Role */}
        {isScan ? (
          <Badge variant="neutral" className="text-[10px] flex-shrink-0">dom-scan</Badge>
        ) : (
          <span className="flex items-center gap-1 flex-shrink-0">
            {call.hasVision
              ? <Eye className="h-3 w-3 text-violet-400" />
              : <EyeOff className="h-3 w-3 text-muted-foreground/20" />
            }
            {call.attempt > 1 && (
              <span className="text-[10px] text-amber-400 font-mono">x{call.attempt}</span>
            )}
          </span>
        )}

        {/* Tokens */}
        <span className="text-[11px] font-mono tabular-nums text-blue-400 w-14 text-right flex-shrink-0">
          {call.inputTokens.toLocaleString()}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-emerald-400 w-14 text-right flex-shrink-0">
          {call.outputTokens.toLocaleString()}
        </span>

        {/* Cost */}
        <span className="text-[11px] font-mono tabular-nums text-foreground/70 w-16 text-right flex-shrink-0">
          {formatCost(call.costUsd)}
        </span>

        {/* Duration */}
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right flex-shrink-0">
          {formatMs(call.durationMs)}
        </span>

        {/* Chevron */}
        {expanded
          ? <ChevronDown className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
        }
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50 space-y-3">
          {/* Screenshot */}
          {call.imageBase64 && (
            <div className="pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Screenshot (sent to LLM)</p>
              <div className="rounded border border-border bg-black overflow-hidden">
                <img
                  src={`data:image/jpeg;base64,${call.imageBase64}`}
                  alt="Screenshot sent to LLM"
                  className="w-full block max-h-64 object-contain object-top"
                />
              </div>
            </div>
          )}
          {/* Query / reasoning */}
          {call.query && (
            <div className={!call.imageBase64 ? "pt-3" : ""}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Query / Reasoning</p>
              <pre className="text-[11px] font-mono bg-muted/40 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-48">
                {call.query}
              </pre>
            </div>
          )}
          {/* Response / content */}
          {call.response && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Response / Content</p>
              <pre className="text-[11px] font-mono bg-muted/40 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-64">
                {call.response}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Memory tab
// ============================================================

function MemoryTab({ memoryLoaded }: { memoryLoaded: MemoryEntryBrief[] }) {
  return (
    <div className="px-6 py-5 max-w-4xl w-full mx-auto animate-fade-in">
      {memoryLoaded.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-5 w-5" />}
          title="No memory loaded"
          description="No semantic memory entries were loaded for this run."
        />
      ) : (
        <div className="space-y-4">
          <SectionLabel
            icon={<Brain className="h-3.5 w-3.5" />}
            text={`Loaded Entries (${memoryLoaded.length})`}
          />

          <div className="space-y-1.5">
            {memoryLoaded.map((entry, i) => (
              <Card key={entry.id ?? i}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {entry.type.replace(/_/g, " ")}
                    </Badge>
                    {entry.source && (
                      <span className="text-[10px] text-muted-foreground/50">{entry.source}</span>
                    )}
                    {entry.confidence != null && (
                      <span className="text-[10px] font-mono text-muted-foreground/40 ml-auto tabular-nums">
                        {entry.confidence}%
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] font-medium text-foreground">{entry.summary}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{entry.content}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Shared sub-components
// ============================================================

function SectionLabel({
  icon,
  text,
  children,
}: {
  icon: React.ReactNode;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-muted-foreground">{icon}</span>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">{text}</p>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  mono,
  variant,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  variant?: "destructive" | "primary";
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">{label}</p>
        <p className={cn(
          "text-lg font-semibold tabular-nums",
          mono && "font-mono",
          variant === "destructive" && "text-destructive",
          variant === "primary" && "text-primary",
          !variant && "text-foreground",
        )}>
          {value}
        </p>
        {sub && <p className="text-[10px] text-muted-foreground/50 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-muted-foreground/60 w-24 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}
