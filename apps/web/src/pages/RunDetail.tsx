import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchRunBugs, getRunStreamUrl, stopRun, patchProjectBug, createMemoryEntry } from "@/projectApi";
import { apiMediaUrl, runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { humanizeRunStep } from "@/lib/agentActivity";
import { cn } from "@/lib/utils";
import {
  statusVariant,
  duration,
  formatCost,
  formatMs,
  formatReportedAt,
} from "@/lib/formatters";
import {
  BUG_SEVERITY_STATUS_DOT,
  runJsonBugDisplayName,
  runJsonBugDetailDescription,
} from "@/lib/bug-issue-display";
import { BugCategoryTag } from "@/components/bug-category-tag";
import { BugScreenshotZoomDialog } from "@/components/bug-screenshot-zoom-dialog";
import {
  Pulse,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Spinner,
  Brain,
  CaretDown,
  CaretRight,
  WarningCircle,
  Eye,
  EyeSlash,
  CurrencyDollar,
  Compass,
  Path,
  FileText,
  FlowArrow,
  Stack,
  Funnel,
  GitBranch,
  Circle,
  Image as ImageIcon,
  Globe,
  ArrowSquareOut,
  Calendar,
  ComputerTower,
} from "@phosphor-icons/react";

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
  source?: "navigator" | "review" | "filmstrip" | "network";
  screenshot?: string;
  /** On-disk JPEG name under run folder (preferred). */
  screenshotPath?: string | null;
  screenshot_path?: string | null;
  /** Legacy: base64 or `/api/bugs/...` */
  screenshotBase64?: string | null;
  screenshot_base64?: string | null;
  name?: string;
  description?: string;
  category?: string;
  /** Navigator observation (a11y / element list) for this step */
  domContext?: string;
  executionMethod?: "stagehand" | "playwright" | "coordinates";
  reviewFeedback?: { type: string; severity: string; description: string }[];
  observation?: string;
  doneResult?: "completed" | "blocked";
};

type AgentPlanItem = { text: string; status: "pending" | "done" | "current" | "failed" };
type AgentActivity = { kind: "observe"; text: string; at: number };
type ActivityEntry =
  | { type: "step"; at: number; step: RunStep }
  | { type: "plan"; at: number; items: AgentPlanItem[] }
  | { type: "activity"; at: number; activity: AgentActivity };

type LLMAgentType =
  | "navigator"
  | "review"
  | "holistic"
  | "summary"
  | "filmstrip"
  | "crawl_link_filter"
  | "crawl_route_filter"
  | "crawl_suggested_flows";

type LLMStoredContentPart =
  | { type: "text"; text: string }
  | { type: "image"; imageIndex: number; label?: string };

type LLMStoredMessage = {
  role: string;
  content: string | LLMStoredContentPart[];
};

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
  requestMessages?: LLMStoredMessage[];
  imageBase64?: string;
  imageBase64s?: string[];
  imagePath?: string;
  imagePaths?: string[];
  response: string;
  role?: "action" | "dom-scan";
  agent?: LLMAgentType;
  crawlContext?: Record<string, unknown>;
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
  bugs_json?: (RunStep & { source?: "navigator" | "review" | "network" | "filmstrip" })[];
  llm_calls_json?: LLMCallRecord[];
};

type Tab = "overview" | "issues" | "llm" | "memory";

// --- Helpers ---

const RUN_BUG_STATUS_BADGE: Record<string, "success" | "warning" | "neutral" | "destructive"> = {
  open: "warning",
  in_progress: "warning",
  resolved: "success",
  wont_fix: "neutral",
};

/** Vision frame for this step: file ref or legacy inline base64. */
function visionImageRefForStep(llmCalls: LLMCallRecord[], stepIndex: number, runId: string): string | undefined {
  const hit = llmCalls.find(
    (c) =>
      c.stepIndex === stepIndex &&
      c.hasVision &&
      (c.imageBase64 || c.imagePath || (c.imagePaths && c.imagePaths.length > 0) || (c.imageBase64s && c.imageBase64s.length > 0)) &&
      (c.agent === "navigator" || c.agent == null),
  );
  if (!hit) return undefined;
  const path = hit.imagePaths?.[0] ?? hit.imagePath;
  if (path) return runScreenshotFileUrl(runId, path);
  return hit.imageBase64 ?? hit.imageBase64s?.[0];
}

function llmCallImageSrc(call: LLMCallRecord, runId: string): string | undefined {
  return llmCallImageSrcByIndex(call, runId, 0);
}

function llmCallImageSrcByIndex(call: LLMCallRecord, runId: string, imageIndex: number): string | undefined {
  const path = call.imagePaths?.[imageIndex];
  if (path) {
    const raw = runScreenshotFileUrl(runId, path);
    if (raw != null && raw !== "") return screenshotRefToSrc(raw) ?? raw;
  }
  const b64 = call.imageBase64s?.[imageIndex] ?? (imageIndex === 0 ? call.imageBase64 : undefined);
  if (b64 == null || b64 === "") return undefined;
  return screenshotRefToSrc(b64) ?? (b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`);
}

/** URLs from filmstrip user prompt lines like `0. https://...` */
function filmstripFrameUrlsFromCall(call: LLMCallRecord): string[] {
  const msgs = call.requestMessages;
  const user = msgs?.find((m) => m.role === "user");
  if (!user || typeof user.content === "string") return [];
  const textPart = user.content.find((p): p is { type: "text"; text: string } => p.type === "text");
  if (!textPart?.text) return [];
  const urls: string[] = [];
  for (const line of textPart.text.split("\n")) {
    const m = /^\s*\d+\.\s+(\S+)/.exec(line.trim());
    if (m?.[1]) urls.push(m[1]);
  }
  return urls;
}

/** Horizontal filmstrip of frames exactly as sent to the filmstrip LLM (visit order). */
function FilmstripSentToModel({ call, runId }: { call: LLMCallRecord; runId: string }) {
  const nPath = call.imagePaths?.length ?? 0;
  const nB64 = call.imageBase64s?.length ?? 0;
  const legacy = call.imagePath || call.imageBase64 ? 1 : 0;
  const frameCount = Math.max(nPath, nB64, legacy);
  const urls = filmstripFrameUrlsFromCall(call);

  if (frameCount === 0) {
    return (
      <div className="rounded-lg border border-dashed border-fuchsia-500/25 bg-fuchsia-500/5 px-3 py-2 text-[11px] text-muted-foreground">
        No filmstrip images stored for this call.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/[0.04] px-3 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Stack className="h-3.5 w-3.5 text-fuchsia-400/90 flex-shrink-0" />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-400/80">
          Filmstrip sent to model ({frameCount} frame{frameCount !== 1 ? "s" : ""}, visit order →)
        </p>
      </div>
      <div className="flex gap-2 overflow-x-auto overflow-y-hidden pb-1 pt-0.5 [scrollbar-gutter:stable] scroll-smooth">
        {Array.from({ length: frameCount }, (_, i) => {
          const src = llmCallImageSrcByIndex(call, runId, i);
          const url = urls[i];
          return (
            <div
              key={i}
              className="flex-shrink-0 w-[min(200px,72vw)] rounded-md border border-border bg-card overflow-hidden shadow-sm"
            >
              <div className="px-2 py-1 border-b border-border/60 bg-muted/30">
                <p className="text-[9px] font-mono text-fuchsia-400/90 tabular-nums">#{i + 1}</p>
                {url ? (
                  <p className="text-[9px] font-mono text-muted-foreground truncate" title={url}>
                    {url}
                  </p>
                ) : (
                  <p className="text-[9px] text-muted-foreground/60">—</p>
                )}
              </div>
              {src ? (
                <img
                  src={src}
                  alt={`Filmstrip frame ${i + 1}`}
                  className="w-full h-28 object-cover object-top bg-black"
                />
              ) : (
                <div className="h-28 flex items-center justify-center text-[10px] text-muted-foreground bg-muted/20">
                  No image
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
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

function llmRoleLabel(role: string): string {
  const r = role.toLowerCase();
  if (r === "system") return "System";
  if (r === "user") return "User";
  if (r === "assistant") return "Assistant";
  if (r === "tool") return "Tool";
  return role;
}

function LLMRequestInspector({
  call,
  runId,
  compact,
}: {
  call: LLMCallRecord;
  runId: string;
  /** Smaller scroll areas for nested step cards */
  compact?: boolean;
}) {
  const scrollReq = compact ? "max-h-36" : "max-h-[min(56vh,520px)]";
  const scrollFallback = compact ? "max-h-28" : "max-h-[min(40vh,360px)]";

  const msgs = call.requestMessages;
  if (msgs && msgs.length > 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-border bg-muted/20 overflow-y-auto overflow-x-auto overscroll-contain",
          scrollReq,
        )}
      >
        <div className="p-3 space-y-4">
          {msgs.map((m, mi) => (
            <div key={mi} className="space-y-2">
              <Badge variant="outline" className="text-[10px] font-mono uppercase h-5">
                {llmRoleLabel(m.role)}
              </Badge>
              {typeof m.content === "string" ? (
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80 leading-relaxed">
                  {m.content}
                </pre>
              ) : (
                <div className="space-y-3">
                  {m.content.map((part, pi) =>
                    part.type === "text" ? (
                      <pre
                        key={pi}
                        className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80 leading-relaxed"
                      >
                        {part.text}
                      </pre>
                    ) : (
                      <div key={pi} className="space-y-1">
                        {part.label && (
                          <p className="text-[10px] text-muted-foreground">{part.label}</p>
                        )}
                        {(() => {
                          const src = llmCallImageSrcByIndex(call, runId, part.imageIndex);
                          return src ? (
                            <div className="rounded border border-border bg-black overflow-hidden">
                              <img
                                src={src}
                                alt={`Model input image ${part.imageIndex + 1}`}
                                className={cn("w-full object-contain object-top", compact ? "max-h-32" : "max-h-72")}
                              />
                            </div>
                          ) : (
                            <p className="text-[10px] text-muted-foreground italic">
                              Image {part.imageIndex + 1} not available on disk
                            </p>
                          );
                        })()}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const pathLen = call.imagePaths?.length ?? 0;
  const b64Len = call.imageBase64s?.length ?? 0;
  const legacyOne = call.imagePath || call.imageBase64 ? 1 : 0;
  const imageSlots = Math.max(pathLen, b64Len, legacyOne);

  return (
    <div className="space-y-3">
      {call.query ? (
        <div
          className={cn(
            "rounded-md border border-border bg-muted/20 overflow-y-auto overflow-x-auto overscroll-contain",
            scrollFallback,
          )}
        >
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-3 text-foreground/80 leading-relaxed">
            {call.query}
          </pre>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">No request text stored for this call.</p>
      )}
      {imageSlots > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Array.from({ length: imageSlots }, (_, i) => {
            const src = llmCallImageSrcByIndex(call, runId, i);
            return src ? (
              <div key={i} className="rounded border border-border bg-black overflow-hidden">
                <p className="text-[9px] font-mono text-muted-foreground px-2 py-1 border-b border-border/50">
                  Image {i + 1}
                </p>
                <img
                  src={src}
                  alt={`Screenshot ${i + 1}`}
                  className={cn("w-full object-contain object-top", compact ? "max-h-28" : "max-h-56")}
                />
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

function badgeVariantForStatus(status: string): "success" | "destructive" | "warning" | "neutral" | "running" {
  if (status === "running") return "running";
  return statusVariant(status);
}

type LlmAgentDisplay = { label: string; color: string; Icon: React.ComponentType<{ className?: string }> };

const LLM_AGENT_CONFIG: Record<LLMAgentType, LlmAgentDisplay> = {
  navigator: { label: "Navigator", color: "text-emerald-400", Icon: Compass },
  review:    { label: "Review",    color: "text-violet-400",  Icon: Eye },
  holistic:  { label: "Flow review", color: "text-violet-300", Icon: GitBranch },
  summary:   { label: "Summary",   color: "text-sky-400",     Icon: FileText },
  filmstrip: { label: "Filmstrip", color: "text-fuchsia-400", Icon: Stack },
  crawl_link_filter:       { label: "Crawl links", color: "text-teal-400",    Icon: Funnel },
  crawl_route_filter:    { label: "Crawl routes", color: "text-teal-300",   Icon: Funnel },
  crawl_suggested_flows: { label: "Crawl flows", color: "text-amber-400",   Icon: FlowArrow },
};

const LLM_TAB_AGENT_ORDER: LLMAgentType[] = [
  "navigator", "holistic", "filmstrip", "summary",
  "crawl_link_filter", "crawl_route_filter", "crawl_suggested_flows",
];

/** Legacy or engine-only agents (e.g. memory_curator) still render in the LLM tab. */
function llmAgentDisplay(agent: string): LlmAgentDisplay {
  const row = (LLM_AGENT_CONFIG as Record<string, LlmAgentDisplay | undefined>)[agent];
  return row ?? { label: agent, color: "text-muted-foreground", Icon: Brain };
}

// --- Main component ---

export const RunDetail: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = React.useState<Run | null>(null);
  const [steps, setSteps] = React.useState<RunStep[]>([]);
  const [llmCalls, setLlmCalls] = React.useState<LLMCallRecord[]>([]);
  const [runBugs, setRunBugs] = React.useState<
    {
      id?: string;
      name: string;
      description: string;
      url?: string | null;
      step_index?: number | null;
      status?: string;
      reported_at?: string;
    }[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [liveScreenshot, setLiveScreenshot] = React.useState<string | null>(null);
  const [agentPlan, setAgentPlan] = React.useState<AgentPlanItem[]>([]);
  const [activityFeed, setActivityFeed] = React.useState<ActivityEntry[]>([]);
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
          setAgentPlan([]);
          setActivityFeed((res.run.steps_json ?? []).map((step: RunStep) => ({ type: "step" as const, step, at: step.at ?? Date.now() })));
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
            setActivityFeed((prev) => [...prev, { type: "step", step: msg.step, at: Date.now() }]);
          }
          if (msg.type === "plan") {
            setAgentPlan(Array.isArray(msg.items) ? msg.items : []);
            setActivityFeed((prev) => [...prev, { type: "plan", items: msg.items ?? [], at: Number(msg.at) || Date.now() }]);
          }
          if (msg.type === "activity" && msg.activity?.kind === "observe") {
            setActivityFeed((prev) => [...prev, { type: "activity", activity: msg.activity, at: Number(msg.activity.at) || Date.now() }]);
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
            setActivityFeed((msg.run?.steps_json ?? []).map((step: RunStep) => ({ type: "step" as const, step, at: step.at ?? Date.now() })));
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
            setActivityFeed((res.run.steps_json ?? []).map((step: RunStep) => ({ type: "step" as const, step, at: step.at ?? Date.now() })));
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
        <PageHeader icon={<Pulse className="h-4 w-4" />} title="Run">
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
        <PageHeader icon={<Pulse className="h-4 w-4" />} title="Run" />
        <EmptyState
          icon={<WarningCircle className="h-6 w-6" />}
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
    <div className="flex flex-col flex-1 min-h-0 w-full">
      {/* Back + breadcrumb + PageHeader */}
      <PageHeader
        icon={<Pulse className="h-4 w-4" />}
        title={`Run ${run.id.slice(0, 8)}`}
      >
        <Badge variant={badgeVariantForStatus(run.status)} dot>
          {run.status}
        </Badge>
        {run.status === "running" && (
          <>
            <Spinner className="h-3.5 w-3.5 text-status-running animate-spin" />
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
          <TabsList>
            <TabsTrigger value="overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="issues">
              Issues
              {bugsFound.length > 0 && (
                <span className="normal-case text-[10px] font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
                  {bugsFound.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="llm">
              LLM Calls
              <span className="normal-case text-[11px] font-mono text-muted-foreground/50">{llmCalls.length}</span>
            </TabsTrigger>
            <TabsTrigger value="memory">
              Memory
              {memoryLoaded.length > 0 && (
                <span className="normal-case text-[11px] font-mono text-muted-foreground/50">{memoryLoaded.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <TabsContent value="overview" className="mt-0 flex-1 min-h-0 flex flex-col overflow-hidden outline-none data-[state=inactive]:hidden">
            <OverviewTab
              run={run}
              steps={steps}
              bugsFound={bugsFound}
              liveScreenshot={liveScreenshot}
              totalCost={totalCost}
              agentPlan={agentPlan}
              activityFeed={activityFeed}
            />
          </TabsContent>

          <TabsContent value="issues" className="mt-0 flex-1 min-h-0 overflow-y-auto outline-none data-[state=inactive]:hidden">
            <IssuesTab
              run={run}
              bugsFound={bugsFound}
              runBugs={runBugs}
              projectId={run.project_id ?? undefined}
            />
          </TabsContent>

          <TabsContent value="llm" className="mt-0 flex-1 min-h-0 overflow-y-auto outline-none data-[state=inactive]:hidden">
            <LLMTab runId={run.id} llmCalls={llmCalls} totalCost={totalCost} />
          </TabsContent>

          <TabsContent value="memory" className="mt-0 flex-1 min-h-0 overflow-y-auto outline-none data-[state=inactive]:hidden">
            <MemoryTab memoryLoaded={memoryLoaded} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

function AgentPipelineCard({ llmCalls, stepsCount }: { llmCalls: LLMCallRecord[]; stepsCount: number }) {
  const hasHolistic = llmCalls.some((c) => c.agent === "holistic");
  const hasFilmstrip = llmCalls.some((c) => c.agent === "filmstrip");
  const navCalls = llmCalls.filter((c) => (c.agent ?? "navigator") === "navigator").length;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <SectionLabel icon={<FlowArrow className="h-3.5 w-3.5" />} text="Agent pipeline" />
        <ol className="text-[12px] text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>
            <span className="text-foreground/90">Auth &amp; navigation</span> — session and target URL
          </li>
          <li>
            <span className="text-foreground/90">Navigator loop</span> — {stepsCount} step{stepsCount !== 1 ? "s" : ""} recorded,{" "}
            {navCalls} LLM decision{navCalls !== 1 ? "s" : ""}
          </li>
          {hasHolistic && (
            <li>
              <span className="text-foreground/90">Flow review</span> — post-run analysis of trace + key page screenshots (functional / navigation)
            </li>
          )}
          {hasFilmstrip && (
            <li>
              <span className="text-foreground/90">Filmstrip</span> — post-run visual journey across visited pages
            </li>
          )}
          <li className="text-muted-foreground/90">
            <span className="text-foreground/90">Network monitor</span> — optional HTTP/console signals (merge into bugs when enabled on the page)
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function AgentCostBreakdownCard({ llmCalls }: { llmCalls: LLMCallRecord[] }) {
  const agents = ["navigator", "holistic", "filmstrip", "summary"] as const;
  const rows = agents
    .map((a) => ({
      agent: a,
      cost: llmCalls.filter((c) => (c.agent ?? "navigator") === a).reduce((s, c) => s + c.costUsd, 0),
      calls: llmCalls.filter((c) => (c.agent ?? "navigator") === a).length,
    }))
    .filter((r) => r.calls > 0);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <SectionLabel icon={<CurrencyDollar className="h-3.5 w-3.5" />} text="Cost by agent" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {rows.map((r) => (
            <div key={r.agent} className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{r.agent}</p>
              <p className="text-[13px] font-mono text-foreground">{formatCost(r.cost)}</p>
              <p className="text-[10px] text-muted-foreground/70">{r.calls} call{r.calls !== 1 ? "s" : ""}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Overview tab
// ============================================================

function PlanChecklistRow({ item, isLast }: { item: AgentPlanItem; isLast: boolean }) {
  const isDone = item.status === "done";
  const isCurrent = item.status === "current";
  const isFailed = item.status === "failed";
  return (
    <li className="stagger-item list-none">
      <div className="flex gap-3">
        <div className="flex w-[22px] shrink-0 flex-col items-center">
          <div
            className={cn(
              "relative z-[1] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full transition-[background-color,box-shadow] duration-150 ease-out",
              isCurrent && "bg-primary/10 ring-2 ring-primary/15",
              !isCurrent && !isDone && !isFailed && "bg-transparent",
            )}
          >
            {isDone ? (
              <CheckCircle className="h-3.5 w-3.5 text-status-pass" weight="bold" />
            ) : isFailed ? (
              <XCircle className="h-3.5 w-3.5 text-destructive/85" weight="bold" />
            ) : isCurrent ? (
              <span className="dot-pulse h-2 w-2 rounded-full bg-primary" />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted-foreground/40" weight="regular" />
            )}
          </div>
          {!isLast && (
            <div
              className="mt-1 min-h-[10px] w-px flex-1 bg-gradient-to-b from-border/50 to-border/15"
              aria-hidden
            />
          )}
        </div>
        <div
          className={cn(
            "min-w-0 flex-1 pb-3 transition-[background-color] duration-150 ease-out",
            isCurrent && "rounded-md bg-primary/[0.035] -mx-1 -mt-0.5 px-2.5 py-1.5",
          )}
        >
          <p
            className={cn(
              "text-[13px] leading-snug tracking-[-0.01em] text-foreground transition-colors duration-150",
              isDone && "text-muted-foreground/85 line-through decoration-border/50 decoration-1",
              isCurrent && "font-medium text-foreground",
              isFailed && "text-destructive/90",
            )}
          >
            {item.text}
          </p>
        </div>
      </div>
    </li>
  );
}

const RUN_PREVIEW_WALLPAPER = "/wallpaper/run_details_wallpaper.png";

/** Wallpaper + optional liquid-glass frame. `crisp` desk = full-bleed art (run starting). `blurred` = softened desk + grain + darken. */
function BrowserPreviewStage({
  badge,
  children,
  empty,
  wallpaperTreatment,
  framed,
  liveFrameOpenAnim,
  onLiveFrameOpenAnimEnd,
}: {
  badge: React.ReactNode;
  children: React.ReactNode;
  empty?: boolean;
  wallpaperTreatment: "crisp" | "blurred";
  framed: boolean;
  liveFrameOpenAnim?: boolean;
  onLiveFrameOpenAnimEnd?: () => void;
}) {
  const deskWallpaper = (
    <div
      className="pointer-events-none absolute inset-0 bg-cover bg-center"
      style={{ backgroundImage: `url(${RUN_PREVIEW_WALLPAPER})` }}
      aria-hidden
    />
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {wallpaperTreatment === "crisp" ? (
        deskWallpaper
      ) : (
        <>
          <div className="pointer-events-none absolute inset-0 bg-muted/50 dark:bg-surface-2/80" aria-hidden />
          <div className="run-preview-wallpaper-blur-wrap" aria-hidden>
            <div
              className="run-preview-wallpaper-blurred opacity-[0.92] dark:opacity-[0.72]"
              style={{ backgroundImage: `url(${RUN_PREVIEW_WALLPAPER})` }}
            />
          </div>
          <div className="run-preview-wallpaper-grain" aria-hidden />
          <div
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.03] via-transparent to-muted/18 dark:from-primary/[0.025] dark:to-background/12"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-0 bg-black/20 dark:bg-black/32"
            aria-hidden
          />
        </>
      )}

      <div className="absolute left-2 top-2 z-20 max-w-[calc(100%-1rem)] sm:left-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]">
        {badge}
      </div>

      <div className="relative z-10 flex min-h-[min(12rem,42svh)] flex-1 items-center justify-center p-2 pt-11 sm:min-h-0 sm:p-4 sm:pt-12 md:p-5 md:pt-14 lg:p-6 lg:pt-[3.75rem]">
        {framed ? (
          <div
            className={cn(
              "run-preview-liquid-shell flex max-h-full min-h-0 w-full max-w-full min-w-0 flex-col",
              liveFrameOpenAnim && "run-preview-window-open-anim",
            )}
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return;
              if (!e.animationName.includes("run-preview-window-open")) return;
              onLiveFrameOpenAnimEnd?.();
            }}
          >
            <div className="run-preview-liquid-inner flex max-h-full min-h-0 w-full flex-1 flex-col">
              <div
                className={cn(
                  "relative z-[1] flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]",
                  empty && "items-center justify-center bg-muted/30 dark:bg-muted/15",
                )}
              >
                {!empty && (
                  <>
                    <div className="pointer-events-none absolute inset-0 bg-muted/35 dark:bg-surface-2/60" aria-hidden />
                    <div className="run-preview-wallpaper-blur-wrap" aria-hidden>
                      <div
                        className="run-preview-wallpaper-blurred opacity-[0.88] dark:opacity-[0.68]"
                        style={{ backgroundImage: `url(${RUN_PREVIEW_WALLPAPER})` }}
                      />
                    </div>
                    <div className="run-preview-wallpaper-grain" aria-hidden />
                    <div
                      className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.03] via-transparent to-muted/14 dark:from-primary/[0.025] dark:to-background/10"
                      aria-hidden
                    />
                    <div
                      className="pointer-events-none absolute inset-0 bg-black/18 dark:bg-black/28"
                      aria-hidden
                    />
                  </>
                )}
                <div className="relative z-[1] flex min-h-0 flex-1 flex-col">{children}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex max-h-full min-h-0 w-full flex-1 flex-col items-center justify-center px-3">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  run, steps, bugsFound, liveScreenshot, totalCost, agentPlan, activityFeed,
}: {
  run: Run;
  steps: RunStep[];
  bugsFound: RunStep[];
  liveScreenshot: string | null;
  totalCost: number;
  agentPlan: AgentPlanItem[];
  activityFeed: ActivityEntry[];
}) {
  const okCount = steps.filter((s) => s.status === "ok" && s.action !== "bug").length;
  const failCount = steps.filter((s) => s.status === "failed").length;
  const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const latestEntry = activityFeed.length > 0 ? activityFeed[activityFeed.length - 1] : null;
  const latestHumanized = latestStep ? humanizeRunStep(latestStep) : null;

  const activityNewestFirst = React.useMemo(
    () => [...activityFeed].reverse(),
    [activityFeed],
  );

  const planProgress = React.useMemo(() => {
    const n = agentPlan.length;
    if (n === 0) return null;
    const done = agentPlan.filter((i) => i.status === "done").length;
    const failed = agentPlan.filter((i) => i.status === "failed").length;
    return { n, done, failed, pct: Math.round((done / n) * 100) };
  }, [agentPlan]);

  const snapshotSrc = React.useMemo(() => {
    const lastWithScreenshot = [...steps]
      .reverse()
      .find((s) =>
        s.screenshotPath || s.screenshot_path || s.screenshotBase64 || s.screenshot_base64 || s.screenshot,
      );
    if (!lastWithScreenshot) return null;
    const fileUrl = runScreenshotFileUrl(run.id, lastWithScreenshot.screenshotPath ?? lastWithScreenshot.screenshot_path);
    const legacyRef =
      lastWithScreenshot.screenshotBase64 ?? lastWithScreenshot.screenshot_base64 ?? lastWithScreenshot.screenshot;
    return fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined) ?? null;
  }, [steps, run.id]);

  const showLive = run.status === "running" && !!liveScreenshot;
  const isRunStarting = run.status === "running" && !liveScreenshot;
  const showRecording = !showLive && !!run.video_url;
  const previewEmpty = !isRunStarting && !showLive && !showRecording && !snapshotSrc;

  const [liveFrameOpenAnim, setLiveFrameOpenAnim] = React.useState(false);
  const seenLivePreviewRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (showLive && !seenLivePreviewRef.current) {
      seenLivePreviewRef.current = true;
      setLiveFrameOpenAnim(true);
    }
    if (!showLive) {
      seenLivePreviewRef.current = false;
      setLiveFrameOpenAnim(false);
    }
  }, [showLive]);

  React.useEffect(() => {
    if (!liveFrameOpenAnim) return;
    const id = window.setTimeout(() => setLiveFrameOpenAnim(false), 700);
    return () => window.clearTimeout(id);
  }, [liveFrameOpenAnim]);

  return (
    <div className="px-6 py-5 flex flex-col flex-1 min-h-0 h-full overflow-hidden animate-fade-in">
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 flex-1 min-h-0 overflow-hidden">
        <Card className="flex h-full min-h-[min(13rem,38svh)] flex-col overflow-hidden sm:min-h-[min(15rem,36svh)] xl:col-span-3 xl:min-h-0">
          <CardContent className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            <BrowserPreviewStage
              empty={previewEmpty}
              wallpaperTreatment={isRunStarting ? "crisp" : "blurred"}
              framed={!isRunStarting}
              liveFrameOpenAnim={liveFrameOpenAnim}
              onLiveFrameOpenAnimEnd={() => setLiveFrameOpenAnim(false)}
              badge={
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/80 bg-card/95 px-2 py-1.5 backdrop-blur-md sm:gap-2 sm:px-2.5 sm:py-2">
                  <Badge
                    variant={
                      isRunStarting || showLive ? "running" : showRecording ? "secondary" : "neutral"
                    }
                    className="text-[10px] uppercase tracking-wider"
                  >
                    {isRunStarting ? "starting" : showLive ? "live" : showRecording ? "recording" : "snapshot"}
                  </Badge>
                  <span
                    className="hidden h-4 w-px shrink-0 bg-border/70 sm:block"
                    aria-hidden
                  />
                  <span className="text-[11px] font-mono font-medium tabular-nums text-foreground/90 sm:text-[12px]">
                    steps {steps.length}
                  </span>
                </div>
              }
            >
              {isRunStarting ? (
                <div className="flex max-w-[min(100%,22rem)] items-center gap-2 rounded-lg border border-primary/30 bg-card/93 px-3 py-2 ring-1 ring-primary/20 backdrop-blur-sm">
                  <Spinner className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" weight="bold" />
                  <p className="font-display text-[11px] font-medium leading-snug tracking-tight text-foreground">
                    Launching a browser for this run…
                  </p>
                </div>
              ) : showLive ? (
                <img
                  src={`data:image/jpeg;base64,${liveScreenshot}`}
                  alt="Live browser"
                  className="h-full w-full min-h-0 flex-1 object-contain"
                />
              ) : showRecording ? (
                <video
                  src={apiMediaUrl(run.video_url!)}
                  controls
                  className="h-full w-full min-h-0 flex-1 object-contain"
                  preload="metadata"
                />
              ) : snapshotSrc ? (
                <img
                  src={snapshotSrc}
                  alt="Run browser preview"
                  className="h-full w-full min-h-0 flex-1 object-contain"
                />
              ) : (
                <p className="px-4 text-center text-[12px] text-muted-foreground">No preview yet</p>
              )}
            </BrowserPreviewStage>
          </CardContent>
        </Card>

        <div className="xl:col-span-2 h-full min-h-0 flex flex-col gap-3 overflow-hidden">
          <Card className="shrink-0">
            <CardContent className="p-3">
              <div className="grid grid-cols-2 gap-2">
                <MetricCard label="Duration" value={duration(run.started_at, run.completed_at) || "--"} mono />
                <MetricCard label="Steps" value={String(steps.length)} sub={`${okCount} ok / ${failCount} fail`} />
                <MetricCard
                  label="Bugs"
                  value={String(bugsFound.length)}
                  variant={bugsFound.length > 0 ? "destructive" : undefined}
                />
                <MetricCard label="LLM Cost" value={formatCost(totalCost)} mono />
              </div>
            </CardContent>
          </Card>

          <Card className="min-h-0 flex-[0.85] flex flex-col overflow-hidden border-border/55 bg-card/90">
            <CardContent className="flex flex-1 min-h-0 flex-col p-0">
              <div className="shrink-0 border-b border-border/40 bg-surface-2/50 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <SectionLabel className="mb-0 min-w-0" icon={<Path className="h-3.5 w-3.5" />} text="Plan" />
                  {planProgress && (
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] tabular-nums text-muted-foreground">
                        <span className="text-foreground/80">{planProgress.done}</span>
                        <span className="text-muted-foreground/50"> / {planProgress.n}</span>
                        {run.status === "running" && agentPlan.some((i) => i.status === "current") && (
                          <span className="ml-2 text-[10px] font-medium uppercase tracking-wider text-primary/80">
                            live
                          </span>
                        )}
                      </p>
                      {planProgress.failed > 0 && (
                        <p className="text-[10px] text-destructive/75 mt-0.5">{planProgress.failed} blocked</p>
                      )}
                    </div>
                  )}
                </div>
                {planProgress && planProgress.n > 0 && (
                  <div
                    className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted/50"
                    role="progressbar"
                    aria-valuenow={planProgress.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-status-pass/45 via-primary/30 to-primary/40 transition-[width] duration-200 ease-out"
                      style={{ width: `${planProgress.pct}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 basis-0 min-h-[88px] max-h-[min(38vh,300px)] overflow-y-auto overflow-x-hidden px-3 py-3 [scrollbar-gutter:stable] touch-pan-y overscroll-contain">
                {agentPlan.length === 0 ? (
                  <div className="flex animate-fade-in flex-col items-center justify-center gap-2.5 py-7 text-center">
                    <div className="rounded-full bg-muted/35 p-3 ring-1 ring-border/30">
                      <Path className="h-6 w-6 text-muted-foreground/35" weight="duotone" />
                    </div>
                    <p className="max-w-[220px] text-[12px] leading-relaxed text-muted-foreground">
                      Checklist steps appear here as the agent streams its plan.
                    </p>
                  </div>
                ) : (
                  <ol className="m-0 list-none p-0">
                    {agentPlan.map((item, idx) => (
                      <PlanChecklistRow
                        key={`${idx}-${item.text.slice(0, 96)}`}
                        item={item}
                        isLast={idx === agentPlan.length - 1}
                      />
                    ))}
                  </ol>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="min-h-0 flex-1 flex flex-col overflow-hidden">
            <CardContent className="p-3 flex flex-col flex-1 min-h-0 gap-0">
              <SectionLabel icon={<Pulse className="h-3.5 w-3.5" />} text="Live action" />
              <div className="rounded border border-border/60 bg-muted/20 px-3 py-2 mt-2 mb-2 shrink-0 transition-all duration-200 animate-fade-in">
                {latestEntry?.type === "activity" ? (
                  <>
                    <p className="text-[14px] text-foreground">Observing {latestEntry.activity.text}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Agent observation</p>
                  </>
                ) : latestEntry?.type === "plan" ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Path className="h-3.5 w-3.5 shrink-0 text-primary/60" weight="duotone" />
                      <p className="text-[13px] text-foreground">
                        Plan refreshed · {latestEntry.items.length}{" "}
                        {latestEntry.items.length === 1 ? "step" : "steps"}
                      </p>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 pl-[22px]">Navigator checklist</p>
                  </>
                ) : latestHumanized ? (
                  <>
                    <div className="flex items-center gap-2">
                      <latestHumanized.icon
                        className={cn(
                          "h-4 w-4 transition-colors duration-200",
                          run.status === "running" ? "text-status-running" : "text-muted-foreground",
                        )}
                      />
                      <p className="text-[14px] text-foreground">{latestHumanized.title}</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {latestHumanized.detail || latestStep?.url || "No details"}
                    </p>
                  </>
                ) : (
                  <p className="text-[12px] text-muted-foreground">Waiting for activity...</p>
                )}
              </div>
              <div className="min-h-0 flex-1 basis-0 min-h-[120px] max-h-[min(50vh,420px)] overflow-y-auto overflow-x-hidden pr-1 pb-0.5 [scrollbar-gutter:stable] touch-pan-y overscroll-contain">
                <div className="space-y-1.5 pr-1">
                  {activityNewestFirst.length === 0 && (
                    <p className="text-[12px] text-muted-foreground">No live actions yet.</p>
                  )}
                  {activityNewestFirst.map((entry, idx) => {
                    const delay = Math.min(idx, 12) * 22;
                    if (entry.type === "plan") {
                      return (
                        <div
                          key={`plan-${entry.at}-${idx}`}
                          className="animate-slide-up rounded-lg border border-border/35 bg-muted/12 px-2.5 py-2 transition-colors duration-150 hover:bg-muted/18"
                          style={{ animationDelay: `${delay}ms` }}
                        >
                          <div className="flex items-start gap-2">
                            <Path className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/50" weight="duotone" />
                            <div className="min-w-0 flex-1">
                              <p className="text-[12px] text-foreground/95">
                                Plan · {entry.items.length} {entry.items.length === 1 ? "step" : "steps"}
                              </p>
                              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
                                {new Date(entry.at).toLocaleTimeString()}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    if (entry.type === "activity") {
                      return (
                        <div
                          key={`act-${entry.at}-${idx}`}
                          className="text-[12px] rounded border border-border/50 px-2 py-1.5 bg-card/40 animate-slide-up transition-colors duration-200"
                          style={{ animationDelay: `${delay}ms` }}
                        >
                          <p className="text-foreground">Observing: {entry.activity.text}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {new Date(entry.at).toLocaleTimeString()}
                          </p>
                        </div>
                      );
                    }
                    const h = humanizeRunStep(entry.step);
                    return (
                      <div
                        key={`step-${entry.step.index}-${entry.at}-${idx}`}
                        className="text-[12px] rounded border border-border/50 px-2 py-1.5 bg-card/40 animate-slide-up transition-colors duration-200"
                        style={{ animationDelay: `${delay}ms` }}
                      >
                        <div className="flex items-center gap-2">
                          <h.icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <p className="text-foreground">{h.title}</p>
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {new Date(entry.at).toLocaleTimeString()}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Issues tab
// ============================================================

function IssuesTab({
  run,
  bugsFound,
  runBugs,
  projectId,
}: {
  run: Run;
  bugsFound: RunStep[];
  runBugs: {
    id?: string;
    name: string;
    description: string;
    url?: string | null;
    step_index?: number | null;
    status?: string;
    reported_at?: string;
  }[];
  projectId?: string;
}) {
  return (
    <div className="px-6 py-5 max-w-4xl w-full mx-auto animate-fade-in">
      {bugsFound.length > 0 ? (
        <div className="mb-4">
          <SectionLabel icon={<WarningCircle className="h-3.5 w-3.5" />} text={`Issues (${bugsFound.length})`} />
          <p className="text-[12px] text-muted-foreground mt-1">
            Findings from the Navigator, review agents, and related signals for this run.
          </p>
        </div>
      ) : null}
      {bugsFound.length === 0 ? (
        <EmptyState
          icon={<WarningCircle className="h-5 w-5" />}
          title="No issues"
          description="Nothing was reported for this run. Check the Overview for live activity and LLM Calls for audit detail."
        />
      ) : (
        <div className="space-y-1.5">
          {bugsFound.map((bug: RunStep & { name?: string }, i: number) => (
            <div key={i} className="animate-fade-in" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              <BugCard bug={bug} runBugs={runBugs} runId={run.id} projectId={projectId} run={run} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Bug card (matches Issues page list + expanded layout)
// ============================================================

function BugCard({
  bug,
  runBugs,
  runId,
  projectId,
  run,
}: {
  bug: any;
  runBugs: {
    id?: string;
    name: string;
    description: string;
    url?: string | null;
    step_index?: number | null;
    status?: string;
    reported_at?: string;
  }[];
  runId: string;
  projectId?: string;
  run: Run;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const displayName = runJsonBugDisplayName(bug);
  const detail = runJsonBugDetailDescription(bug, displayName);
  const category = String(bug.category ?? bug.bugType ?? "other");

  const nameNorm = (bug.name ?? "").trim();
  const bodyNorm = (bug.description ?? bug.reasoning ?? "").trim();
  const dbBug = runBugs.find(
    (b) =>
      (typeof bug.index === "number" && b.step_index != null && b.step_index === bug.index) ||
      (b.name.trim() === nameNorm && b.description.trim() === bodyNorm) ||
      (b.description.trim() === bodyNorm && (b.url ?? "").trim() === (bug.url ?? "").trim()),
  );
  const reportedIso = dbBug?.reported_at ?? run.completed_at ?? run.started_at ?? "";

  async function resolveIssue() {
    if (!projectId || !dbBug?.id) return;
    setBusy(true);
    try {
      await patchProjectBug(projectId, dbBug.id, { status: "resolved" });
    } finally {
      setBusy(false);
    }
  }

  async function ignoreIssue() {
    if (!projectId || !dbBug?.id) return;
    setBusy(true);
    try {
      await patchProjectBug(projectId, dbBug.id, { status: "wont_fix" });
      const bodyForMemory = detail || bodyNorm;
      await createMemoryEntry(projectId, {
        type: "ignore_region",
        summary: `Ignored issue: ${displayName}`,
        content: `${bodyForMemory}\n\n${bug.url ? `URL: ${bug.url}` : ""}`.trim(),
        confidence: 100,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card overflow-hidden transition-colors",
        expanded && "ring-1 ring-border",
      )}
    >
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <CaretDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <CaretRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <StatusDot status={BUG_SEVERITY_STATUS_DOT[bug.severity] ?? "stale"} />
        <span className="text-[13px] font-medium text-foreground truncate flex-1 min-w-0">{displayName}</span>
        <BugCategoryTag category={category} />
        {dbBug?.status && (
          <Badge
            variant={RUN_BUG_STATUS_BADGE[dbBug.status] ?? "neutral"}
            className="capitalize flex-shrink-0 text-[10px]"
          >
            {dbBug.status.replace("_", " ")}
          </Badge>
        )}
        <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0 tabular-nums">
          {reportedIso ? formatReportedAt(reportedIso) : "—"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/10 animate-fade-in">
          {detail ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                Description
              </p>
              <p className="text-[13px] text-foreground whitespace-pre-wrap">{detail}</p>
            </div>
          ) : null}

          {(() => {
            const fileUrl = runScreenshotFileUrl(runId, bug.screenshotPath ?? bug.screenshot_path);
            const legacyRef =
              bug.screenshotBase64 ?? bug.screenshot_base64 ?? bug.screenshot;
            const src = fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined);
            if (!src) return null;
            return (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" />
                  Screenshot
                </p>
                <div onClick={(e) => e.stopPropagation()}>
                  <BugScreenshotZoomDialog src={src} />
                </div>
              </div>
            );
          })()}

          <div className="flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
            {run.environment && (
              <span className="flex items-center gap-1">
                <ComputerTower className="h-3.5 w-3.5 flex-shrink-0" />
                {run.environment}
              </span>
            )}
            {bug.url && (
              <a
                href={bug.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-foreground transition-colors font-mono truncate max-w-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <Globe className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{bug.url}</span>
                <ArrowSquareOut className="h-3 w-3 flex-shrink-0" />
              </a>
            )}
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {reportedIso ? new Date(reportedIso).toLocaleString() : "—"}
            </span>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              {projectId && dbBug?.id && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      resolveIssue();
                    }}
                  >
                    Resolve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      ignoreIssue();
                    }}
                  >
                    Ignore
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <button
              type="button"
              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 hover:text-foreground/70"
              onClick={(e) => {
                e.stopPropagation();
                setShowRaw(!showRaw);
              }}
            >
              Show raw data {showRaw ? "▼" : "▶"}
            </button>
            {showRaw && (
              <pre className="mt-2 text-[11px] font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-foreground/70 max-h-48">
                {JSON.stringify(bug, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// LLM Calls tab
// ============================================================

function LLMTab({ runId, llmCalls, totalCost }: { runId: string; llmCalls: LLMCallRecord[]; totalCost: number }) {
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
    for (const a of LLM_TAB_AGENT_ORDER) {
      counts[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).length;
    }
    return counts;
  }, [llmCalls]);

  const agentCosts = React.useMemo(() => {
    const cost: Record<string, number> = {};
    for (const a of LLM_TAB_AGENT_ORDER) {
      cost[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).reduce((s, c) => s + c.costUsd, 0);
    }
    return cost;
  }, [llmCalls]);

  const agentsWithCalls = LLM_TAB_AGENT_ORDER.filter((a) => (agentCounts[a] ?? 0) > 0);

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
          icon={<CurrencyDollar className="h-5 w-5" />}
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
              const { label, Icon, color } = llmAgentDisplay(a);
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
                const { label } = llmAgentDisplay(a);
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
              <LLMCallRow key={call.seq} call={call} runId={runId} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LLMCallRow({ call, runId }: { call: LLMCallRecord; runId: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const isScan = call.role === "dom-scan";
  const agent  = call.agent ?? "navigator";
  const agentInfo = llmAgentDisplay(agent);

  return (
    <Card className={cn(
      "overflow-visible transition-colors",
      agent === "navigator" && "border-l-2 border-l-emerald-500/30",
      agent === "review"    && "border-l-2 border-l-violet-500/30",
      agent === "holistic"  && "border-l-2 border-l-violet-400/30",
      agent === "summary"   && "border-l-2 border-l-sky-500/30",
      agent === "filmstrip" && "border-l-2 border-l-fuchsia-500/30",
      agent === "crawl_link_filter" && "border-l-2 border-l-teal-500/30",
      agent === "crawl_route_filter" && "border-l-2 border-l-teal-500/30",
      agent === "crawl_suggested_flows" && "border-l-2 border-l-amber-500/30",
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
        <span className={cn("text-[10px] font-medium flex items-center gap-0.5 flex-shrink-0", agentInfo.color)}>
          <agentInfo.Icon className="h-3 w-3" />
          {agentInfo.label}
        </span>

        {/* Model */}
        <span className="text-[11px] text-foreground truncate flex-1 min-w-0">{call.model}</span>

        {/* Role */}
        {isScan ? (
          <Badge variant="neutral" className="text-[10px] flex-shrink-0">dom-scan</Badge>
        ) : (
          <span className="flex items-center gap-1 flex-shrink-0">
            {call.hasVision
              ? <Eye className="h-3 w-3 text-violet-400" />
              : <EyeSlash className="h-3 w-3 text-muted-foreground/20" />
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
          ? <CaretDown className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
          : <CaretRight className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
        }
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-border/50 space-y-4 min-h-0">
          {call.agent === "filmstrip" && <FilmstripSentToModel call={call} runId={runId} />}
          <div className="space-y-2 min-h-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Request (full payload)
            </p>
            <LLMRequestInspector call={call} runId={runId} />
          </div>
          {call.response ? (
            <div className="space-y-2 min-h-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Response
              </p>
              <div className="h-[min(48vh,420px)] min-h-[10rem] overflow-y-auto overflow-x-auto overscroll-contain rounded-md border border-border bg-muted/20 [scrollbar-gutter:stable]">
                <pre className="block w-full min-w-0 text-[11px] font-mono whitespace-pre-wrap break-words p-3 text-foreground/80 leading-relaxed">
                  {call.response}
                </pre>
              </div>
            </div>
          ) : null}
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
  className,
}: {
  icon: React.ReactNode;
  text: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center gap-2", className)}>
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
