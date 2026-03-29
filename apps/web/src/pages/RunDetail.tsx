import React from "react";
import ReactMarkdown from "react-markdown";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchRunBugs, getRunStreamUrl, stopRun } from "@/projectApi";
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
  Workflow,
  Layers,
  Search,
  ListFilter,
  Copy,
  GitBranch,
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
  source?: "navigator" | "review" | "pathgen" | "filmstrip" | "network";
  screenshot?: string;
  /** On-disk JPEG name under run folder (preferred). */
  screenshotPath?: string | null;
  screenshot_path?: string | null;
  /** Legacy: base64 or `/api/bugs/...` */
  screenshotBase64?: string | null;
  screenshot_base64?: string | null;
  stepsToReproduce?: string[];
  name?: string;
  description?: string;
  category?: string;
  /** Navigator observation (a11y / element list) for this step */
  domContext?: string;
  executionMethod?: "stagehand" | "playwright" | "coordinates";
  reviewFeedback?: { type: string; severity: string; description: string }[];
};

type LLMAgentType = "navigator" | "review" | "pathgen" | "summary" | "filmstrip";

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
  bugs_json?: (RunStep & { source?: "navigator" | "review" | "network" | "pathgen" | "filmstrip" })[];
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
        <Layers className="h-3.5 w-3.5 text-fuchsia-400/90 flex-shrink-0" />
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

type StepsGlyphIcon = React.ComponentType<{ className?: string; strokeWidth?: number | string }>;

/** Action glyphs use theme tokens (primary, status-*, destructive) — matches app palette. */
function getActionGlyph(action: string): { Icon: StepsGlyphIcon; tile: string } {
  switch (action) {
    case "fill":
      return { Icon: Keyboard, tile: "bg-primary/12 text-primary shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]" };
    case "click":
      return { Icon: MousePointerClick, tile: "bg-status-pass/12 text-status-pass shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]" };
    case "navigate":
      return { Icon: Navigation, tile: "bg-status-running/12 text-status-running shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]" };
    case "assert":
      return { Icon: CheckCircle2, tile: "bg-status-warn/12 text-status-warn shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]" };
    case "auth":
      return { Icon: LogIn, tile: "bg-secondary text-secondary-foreground" };
    case "wait":
      return { Icon: Timer, tile: "bg-muted text-muted-foreground" };
    case "bug":
      return { Icon: Bug, tile: "bg-destructive/12 text-destructive shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]" };
    case "done":
      return { Icon: CheckCircle2, tile: "bg-status-pass/12 text-status-pass shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]" };
    default:
      return { Icon: Globe, tile: "bg-muted/90 text-muted-foreground" };
  }
}

function StepActionGlyph({ action, className }: { action: string; className?: string }) {
  const { Icon, tile } = getActionGlyph(action);
  return (
    <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-md", tile, className)}>
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
    </span>
  );
}

function timelineNodeRing(step: RunStep): string {
  const isBug = step.action === "bug";
  if (isBug) return "border-destructive/50";
  if (step.status === "failed") return "border-status-fail/55";
  if (step.status === "skipped") return "border-muted-foreground/35 bg-muted/20";
  return "border-status-pass/45";
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
  filmstrip: { label: "Filmstrip", color: "text-fuchsia-400", Icon: Layers },
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
            <StepsTab steps={steps} run={run} liveScreenshot={liveScreenshot} llmCalls={llmCalls} />
          </TabsContent>

          <TabsContent value="llm" className="mt-0">
            <LLMTab runId={run.id} llmCalls={llmCalls} totalCost={totalCost} />
          </TabsContent>

          <TabsContent value="memory" className="mt-0">
            <MemoryTab memoryLoaded={memoryLoaded} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

function AgentPipelineCard({ llmCalls, stepsCount }: { llmCalls: LLMCallRecord[]; stepsCount: number }) {
  const hasPathGen = llmCalls.some((c) => c.agent === "pathgen");
  const hasReview = llmCalls.some((c) => c.agent === "review");
  const hasFilmstrip = llmCalls.some((c) => c.agent === "filmstrip");
  const hasSummary = llmCalls.some((c) => c.agent === "summary");
  const navCalls = llmCalls.filter((c) => (c.agent ?? "navigator") === "navigator").length;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <SectionLabel icon={<Workflow className="h-3.5 w-3.5" />} text="Agent pipeline" />
        <ol className="text-[12px] text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>
            <span className="text-foreground/90">Auth &amp; navigation</span> — session and target URL
          </li>
          {hasPathGen && (
            <li>
              <span className="text-foreground/90">Path Generator</span> — test plan text injected into Navigator context
            </li>
          )}
          <li>
            <span className="text-foreground/90">Navigator loop</span> — {stepsCount} step{stepsCount !== 1 ? "s" : ""} recorded,{" "}
            {navCalls} LLM decision{navCalls !== 1 ? "s" : ""}
          </li>
          {hasReview && (
            <li>
              <span className="text-foreground/90">Review agent</span> — parallel screenshot analysis
            </li>
          )}
          {hasFilmstrip && (
            <li>
              <span className="text-foreground/90">Filmstrip</span> — post-run journey review across visited pages
            </li>
          )}
          {hasSummary && (
            <li>
              <span className="text-foreground/90">Summary</span> — run report
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

function PathGeneratorCard({ llmCalls }: { llmCalls: LLMCallRecord[] }) {
  const call = llmCalls.find((c) => c.agent === "pathgen");
  if (!call?.response) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <SectionLabel icon={<Route className="h-3.5 w-3.5" />} text="Path Generator plan" />
        <p className="text-[11px] text-muted-foreground">
          Plan passed to the Navigator (model: <span className="font-mono">{call.model}</span>
          {call.costUsd > 0 ? `, ${formatCost(call.costUsd)}` : ""}).
        </p>
        <pre className="text-[11px] font-mono bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-foreground/80 border border-border/50">
          {call.response}
        </pre>
      </CardContent>
    </Card>
  );
}

function AgentCostBreakdownCard({ llmCalls }: { llmCalls: LLMCallRecord[] }) {
  const agents = ["navigator", "review", "filmstrip", "pathgen", "summary"] as const;
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
        <SectionLabel icon={<DollarSign className="h-3.5 w-3.5" />} text="Cost by agent" />
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
          <CardContent className="p-4 prose prose-sm dark:prose-invert max-w-none
            prose-headings:text-foreground prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
            prose-h2:text-[16px] prose-h2:mt-0 prose-h2:mb-3 prose-h2:border-b prose-h2:border-border prose-h2:pb-2
            prose-h3:text-[14px] prose-h3:mt-4 prose-h3:mb-2
            prose-h4:text-[13px] prose-h4:mt-3 prose-h4:mb-1
            prose-p:text-[13px] prose-p:text-foreground/90 prose-p:leading-relaxed prose-p:my-1.5
            prose-li:text-[13px] prose-li:text-foreground/90 prose-li:my-0.5
            prose-ul:my-1 prose-ol:my-1
            prose-strong:text-foreground prose-strong:font-medium
            prose-code:text-[12px] prose-code:font-mono prose-code:bg-muted prose-code:text-foreground prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
            prose-table:text-[12px] prose-table:w-full
            prose-thead:border-b prose-thead:border-border
            prose-th:text-[11px] prose-th:font-medium prose-th:uppercase prose-th:tracking-wider prose-th:text-muted-foreground prose-th:text-left
            prose-th:py-2 prose-th:px-3
            prose-td:py-2 prose-td:px-3 prose-td:text-foreground/90
            prose-tr:border-b prose-tr:border-border/50
            prose-a:text-primary prose-a:no-underline hover:prose-a:underline
            prose-hr:border-border
          ">
            <ReactMarkdown>{run.summary}</ReactMarkdown>
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

      <AgentPipelineCard llmCalls={llmCalls} stepsCount={steps.length} />
      <PathGeneratorCard llmCalls={llmCalls} />
      <AgentCostBreakdownCard llmCalls={llmCalls} />

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
                href={apiMediaUrl(run.video_url)}
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
            <video src={apiMediaUrl(run.video_url)} controls className="w-full max-h-[480px]" preload="metadata" />
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
              <BugCard key={i} bug={bug} index={i} runBugs={runBugs} runId={run.id} />
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
  runId,
}: {
  bug: any;
  index: number;
  runBugs: { id?: string; name: string; description: string; url?: string | null }[];
  runId: string;
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
              {bug.source === "review" ? "Review" : bug.source === "navigator" ? "Nav" : bug.source === "pathgen" ? "Path" : bug.source === "filmstrip" ? "Filmstrip" : bug.source}
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

          {/* Screenshot: file on volume (screenshotPath) or legacy inline / URL */}
          {(() => {
            const fileUrl = runScreenshotFileUrl(runId, bug.screenshotPath ?? bug.screenshot_path);
            const legacyRef =
              bug.screenshotBase64 ??
              bug.screenshot_base64 ??
              bug.screenshot;
            const src = fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined);
            if (!src) return null;
            return (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Screenshot</p>
                <div className="rounded border border-border bg-black overflow-hidden">
                  <img
                    src={src}
                    alt="Bug screenshot"
                    className="w-full block max-h-64 object-contain object-top"
                  />
                </div>
              </div>
            );
          })()}

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

type StepsFilter = "all" | "issues" | "bugs" | "memory";

function StepsTab({ steps, run, liveScreenshot, llmCalls }: { steps: RunStep[]; run: Run; liveScreenshot: string | null; llmCalls: LLMCallRecord[] }) {
  const llmCallsByStep = React.useMemo(() => {
    const map = new Map<number, LLMCallRecord[]>();
    for (const call of llmCalls) {
      const key = call.stepIndex ?? 0;
      const arr = map.get(key) || [];
      arr.push(call);
      map.set(key, arr);
    }
    return map;
  }, [llmCalls]);

  const [filter, setFilter] = React.useState<StepsFilter>("all");
  const [query, setQuery] = React.useState("");

  const stats = React.useMemo(() => {
    const ok = steps.filter((s) => s.status === "ok" && s.action !== "bug").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const skipped = steps.filter((s) => s.status === "skipped").length;
    const bugs = steps.filter((s) => s.action === "bug").length;
    const memory = steps.filter((s) => s.fromMemory).length;
    const times = steps.map((s) => s.at).filter((a): a is number => typeof a === "number");
    const spanMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
    return { ok, failed, skipped, bugs, memory, spanMs };
  }, [steps]);

  const filteredSteps = React.useMemo(() => {
    let list = steps;
    if (filter === "issues") list = list.filter((s) => s.status === "failed");
    if (filter === "bugs") list = list.filter((s) => s.action === "bug");
    if (filter === "memory") list = list.filter((s) => s.fromMemory);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((s) => {
        const hay = [
          s.action,
          s.target,
          s.value,
          s.reasoning,
          s.url,
          s.error,
          s.assertion,
          String(s.index),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [steps, filter, query]);

  const scrollToStep = React.useCallback((idx: number) => {
    document.getElementById(`run-step-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const filterBtn = (id: StepsFilter, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setFilter(id)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
        filter === id
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border/80 bg-background/50 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {label}
      {count != null && count > 0 && (
        <span className="tabular-nums text-muted-foreground/80">{count}</span>
      )}
    </button>
  );

  return (
    <div className="px-4 sm:px-6 py-5 max-w-5xl w-full mx-auto space-y-5 animate-fade-in">

      {run.status === "running" && liveScreenshot && (
        <Card className="overflow-hidden border-red-500/20 bg-gradient-to-br from-red-500/[0.06] to-transparent">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60 bg-black/20">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Live browser</span>
              </div>
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-500">
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                Live
              </span>
            </div>
            <div className="bg-black">
              <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="w-full block max-h-[min(52vh,420px)] object-contain object-top" />
            </div>
          </CardContent>
        </Card>
      )}

      {steps.length === 0 ? (
        run.status === "running" ? (
          <Card>
            <CardContent className="flex flex-col items-center py-16 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
              <p className="text-sm font-medium text-foreground">Waiting for the first step</p>
              <p className="text-[13px] text-muted-foreground text-center max-w-sm">
                The agent is exploring your app. Navigator actions will appear here as they complete.
              </p>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={<Hash className="h-5 w-5" />}
            title="No steps recorded"
            description="This run has no step data. Try re-running the test or check the run summary for errors."
          />
        )
      ) : (
        <>
          {/* Summary + controls */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              <MetricCard label="Total steps" value={String(steps.length)} sub={`${stats.ok} succeeded`} />
              <MetricCard
                label="Issues"
                value={String(stats.failed + stats.bugs)}
                sub={stats.failed ? `${stats.failed} failed` : stats.bugs ? `${stats.bugs} bug reports` : "None"}
                variant={stats.failed + stats.bugs > 0 ? "destructive" : undefined}
              />
              <MetricCard label="From memory" value={String(stats.memory)} sub={stats.memory ? "Used cached context" : "—"} />
              <MetricCard
                label="Step span"
                value={stats.spanMs != null ? formatMs(stats.spanMs) : "—"}
                sub={stats.spanMs != null ? "First → last timestamp" : "No timestamps"}
                mono
              />
            </div>

            <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search actions, targets, URLs, errors…"
                  className="h-9 pl-8 text-[13px] bg-background/80"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  <ListFilter className="h-3 w-3" />
                  Show
                </span>
                {filterBtn("all", "All", steps.length)}
                {filterBtn("issues", "Failed", stats.failed)}
                {filterBtn("bugs", "Bugs", stats.bugs)}
                {filterBtn("memory", "Memory", stats.memory)}
              </div>
            </div>

            {/* Timeline scrubber — theme-aligned status ticks */}
            <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-card via-card to-muted/25 p-4 shadow-sm">
              <div className="mb-3 flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
                  <GitBranch className="h-4 w-4" strokeWidth={2} />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-[12px] font-semibold tracking-tight text-foreground">Run timeline</p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Same order as the spine below. Each tick matches step outcome (pass, fail, bug).
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 [scrollbar-gutter:stable]">
                {steps.map((s) => {
                  const isBug = s.action === "bug";
                  const failed = s.status === "failed";
                  const skipped = s.status === "skipped";
                  const tick =
                    isBug ? "bg-destructive"
                      : failed ? "bg-status-fail"
                        : skipped ? "bg-muted-foreground/45"
                          : "bg-status-pass";
                  return (
                    <button
                      key={s.index}
                      type="button"
                      onClick={() => scrollToStep(s.index)}
                      title={`Step ${s.index}`}
                      className={cn(
                        "group flex min-w-[2.75rem] flex-col items-center gap-1.5 rounded-xl border px-2 py-2 transition-all",
                        "border-border/70 bg-background/40 hover:border-primary/30 hover:bg-primary/[0.06] hover:shadow-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        isBug && "border-destructive/20 hover:border-destructive/35",
                        failed && !isBug && "border-status-fail/15 hover:border-status-fail/35",
                      )}
                    >
                      <span className={cn("h-1 w-full max-w-[2rem] rounded-full opacity-90", tick)} />
                      <span className="text-[11px] font-mono font-semibold tabular-nums text-foreground/90 group-hover:text-foreground">
                        {s.index}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {filteredSteps.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm font-medium text-foreground">No steps match</p>
                <p className="text-[13px] text-muted-foreground mt-1">
                  Try clearing the search or switching the filter.
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => { setQuery(""); setFilter("all"); }}>
                  Reset filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Showing <span className="font-mono text-foreground">{filteredSteps.length}</span> of{" "}
                <span className="font-mono text-foreground">{steps.length}</span> steps
              </p>

              <div className="relative">
                {/* Vertical spine — theme gradient, sits behind nodes */}
                <div
                  className="pointer-events-none absolute left-[22px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/40 via-border/90 to-muted-foreground/20"
                  aria-hidden
                />
                <div className="space-y-0">
                  {filteredSteps.map((step, i) => (
                    <StepTimelineRow
                      key={`${step.index}-${i}`}
                      step={step}
                      isLast={i === filteredSteps.length - 1 && run.status !== "running"}
                      stepLLMCalls={llmCallsByStep.get(step.index) ?? []}
                      llmCalls={llmCalls}
                      runId={run.id}
                    />
                  ))}
                </div>
              </div>

              {run.status === "running" && (
                <Card className="border-dashed border-primary/25 bg-primary/[0.03]">
                  <CardContent className="flex items-center gap-3 py-4 px-4">
                    <Loader2 className="h-5 w-5 text-primary animate-spin flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Agent is working</p>
                      <p className="text-[12px] text-muted-foreground">More steps will appear here as the run progresses.</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function executionMethodLabel(m?: RunStep["executionMethod"]): string {
  switch (m) {
    case "stagehand":
      return "Stagehand act";
    case "coordinates":
      return "Coordinates / fallback";
    case "playwright":
      return "Playwright locator";
    default:
      return "";
  }
}

function StepTimelineRow({
  step,
  isLast: _isLast,
  stepLLMCalls,
  llmCalls,
  runId,
}: {
  step: RunStep;
  isLast: boolean;
  stepLLMCalls: LLMCallRecord[];
  llmCalls: LLMCallRecord[];
  runId: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const isBug = step.action === "bug";
  const visionRef = visionImageRefForStep(llmCalls, step.index, runId);
  const visionSrc = visionRef ? (screenshotRefToSrc(visionRef) ?? visionRef) : undefined;
  const hasDetail = !!(
    step.reasoning ||
    step.error ||
    step.url ||
    stepLLMCalls.length > 0 ||
    step.domContext ||
    (step.reviewFeedback && step.reviewFeedback.length > 0) ||
    step.executionMethod ||
    visionSrc
  );
  const stepCost = stepLLMCalls.reduce((sum, c) => sum + c.costUsd, 0);
  const stepTokens = stepLLMCalls.reduce((sum, c) => sum + c.totalTokens, 0);

  const primaryLine = isBug
    ? [
        step.bugType && `${step.bugType}`,
        step.severity && `(${step.severity})`,
        step.reasoning,
      ].filter(Boolean).join(" ")
    : [
        step.target && `${step.target}`,
        step.value && `= "${step.value}"`,
        step.assertion && `assert "${step.assertion}"`,
      ].filter(Boolean).join(" ")
    || step.reasoning
    || (step.action === "navigate" && step.url ? step.url : "—");

  return (
    <div
      className="relative z-10 flex scroll-mt-28 gap-3 pb-8 last:pb-2"
      id={`run-step-${step.index}`}
    >
      {/* Timeline node — rings use status tokens; glyph uses action tokens */}
      <div className="flex w-11 shrink-0 justify-center pt-4">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full border-2 bg-card ring-4 ring-background",
            "shadow-sm",
            timelineNodeRing(step),
            isBug && "bg-destructive/[0.04]",
          )}
        >
          <StepActionGlyph action={step.action} />
        </div>
      </div>

      <Card
        className={cn(
          "min-w-0 flex-1 overflow-hidden border-border/60 bg-card/95 shadow-sm transition-shadow backdrop-blur-sm",
          hasDetail && "hover:shadow-md",
          isBug && "border-destructive/20 bg-destructive/[0.035]",
        )}
      >
        <button
          type="button"
          className={cn(
            "w-full text-left px-4 py-3.5 sm:py-4 transition-colors",
            hasDetail && "hover:bg-accent/20 cursor-pointer",
            !hasDetail && "cursor-default",
          )}
          onClick={() => hasDetail && setExpanded(!expanded)}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono font-semibold tabular-nums text-muted-foreground">
                  #{step.index}
                </span>
                <span
                  className={cn(
                    "text-[13px] font-mono font-semibold tracking-tight",
                    isBug ? "text-destructive" : step.status === "failed" ? "text-status-fail" : "text-foreground",
                  )}
                >
                  {step.action}
                </span>
                {step.source && (
                  <Badge variant="outline" className="h-5 text-[10px] font-normal capitalize">
                    {step.source}
                  </Badge>
                )}
                {!isBug && step.status === "ok" && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-status-pass" strokeWidth={2} />
                )}
                {step.status === "failed" && <XCircle className="h-3.5 w-3.5 text-status-fail" strokeWidth={2} />}
                {step.status === "skipped" && (
                  <Badge variant="neutral" className="text-[10px]">
                    skipped
                  </Badge>
                )}
              </div>
              <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-3 break-words">
                {primaryLine}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {step.executionMethod && !isBug && (
                  <Badge variant="outline" className="h-5 text-[10px] font-mono uppercase" title="How the action was executed">
                    {step.executionMethod === "stagehand" ? "Stagehand" : step.executionMethod === "coordinates" ? "Coordinates" : "Playwright"}
                  </Badge>
                )}
                {step.fromMemory && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    <Zap className="h-3 w-3" strokeWidth={2} />
                    Memory
                  </span>
                )}
                {stepLLMCalls.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Brain className="h-3 w-3" strokeWidth={2} />
                    {stepLLMCalls.length} LLM call{stepLLMCalls.length !== 1 ? "s" : ""}
                  </span>
                )}
                {stepCost > 0 && (
                  <span className="text-[10px] font-mono tabular-nums text-muted-foreground/90">{formatCost(stepCost)}</span>
                )}
              </div>
              {step.url && !isBug && (
                <p className="text-[11px] font-mono text-muted-foreground/70 truncate" title={step.url}>
                  {step.url.replace(/^https?:\/\//, "")}
                </p>
              )}
            </div>

            <div className="flex shrink-0 flex-row items-center justify-between gap-3 border-t border-border/40 pt-3 sm:flex-col sm:border-t-0 sm:pt-0 sm:items-end sm:justify-start sm:pl-2">
              {step.at != null && (
                <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{formatStepTime(step.at)}</span>
              )}
              {hasDetail && (
                <span className="text-muted-foreground/60">
                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              )}
            </div>
          </div>
        </button>

      {expanded && (
        <div className="border-t border-border/60 bg-muted/25 px-4 py-4 space-y-3">
          <details className="rounded-md border border-border/40 bg-background/20 px-2 py-1.5">
            <summary className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 cursor-pointer flex items-center gap-1.5">
              <Workflow className="h-3 w-3 shrink-0" />
              Agent trace — view, execution, review, DOM
            </summary>
            <div className="mt-2 space-y-2 border-l-2 border-primary/25 pl-2 ml-0.5">
              {step.executionMethod && !isBug && (
                <p className="text-[11px] text-muted-foreground">
                  <span className="text-foreground/80 font-medium">Execution:</span>{" "}
                  {executionMethodLabel(step.executionMethod)}
                </p>
              )}
              {visionSrc && !isBug && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1">View sent to Navigator</p>
                  <div className="rounded border border-border overflow-hidden max-w-md bg-black/40">
                    <img
                      src={visionSrc}
                      alt="Navigator view"
                      className="w-full max-h-48 object-contain object-top"
                    />
                  </div>
                </div>
              )}
              {step.reviewFeedback && step.reviewFeedback.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1">Review agent</p>
                  <ul className="space-y-1">
                    {step.reviewFeedback.map((rf, ri) => (
                      <li key={ri} className="text-[11px] text-violet-300/90 bg-violet-500/5 border border-violet-500/15 rounded px-2 py-1">
                        <span className="font-mono text-[10px] text-violet-400/80">{rf.type}</span>
                        {rf.severity && <span className="text-muted-foreground/60 ml-1">({rf.severity})</span>}
                        <span className="block text-muted-foreground mt-0.5">{rf.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {step.domContext && !isBug && (
                <details>
                  <summary className="text-[10px] font-medium text-muted-foreground cursor-pointer flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    Element list / a11y context ({step.domContext.length.toLocaleString()} chars)
                  </summary>
                  <pre className="mt-1 text-[10px] font-mono text-muted-foreground/80 bg-background/50 rounded p-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words border border-border/40">
                    {step.domContext}
                  </pre>
                </details>
              )}
            </div>
          </details>

          {step.url && (
            <div className="flex items-start gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5">
              <p className="text-[11px] font-mono text-muted-foreground/80 break-all flex-1 min-w-0 leading-relaxed">{step.url}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                title="Copy URL"
                onClick={() => void navigator.clipboard.writeText(step.url!)}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {step.reasoning && !isBug && (
            <p className="text-[12px] text-muted-foreground">{step.reasoning}</p>
          )}
          {step.error && (
            <p className="text-[11px] font-mono text-destructive bg-destructive/5 rounded px-2 py-1">
              {step.error}
            </p>
          )}

          {/* Per-step LLM calls */}
          {stepLLMCalls.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 flex items-center gap-1.5">
                <Brain className="h-3 w-3" />
                LLM Calls ({stepLLMCalls.length}) — {stepTokens.toLocaleString()} tokens — {formatCost(stepCost)}
              </p>
              {stepLLMCalls.map((call, ci) => (
                <details key={ci} className="group">
                  <summary className="text-[11px] font-mono cursor-pointer hover:text-foreground text-muted-foreground flex items-center gap-2">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase",
                      call.agent === "navigator" ? "bg-emerald-500/10 text-emerald-400"
                        : call.agent === "review" ? "bg-violet-500/10 text-violet-400"
                        : "bg-amber-500/10 text-amber-400"
                    )}>{call.agent ?? "nav"}</span>
                    <span>{call.model}</span>
                    {call.hasVision && <Eye className="h-3 w-3 text-blue-400" />}
                    <span className="ml-auto tabular-nums">{formatMs(call.durationMs)}</span>
                  </summary>
                  <div className="mt-1 ml-2 space-y-2 text-[10px] text-muted-foreground/80">
                    <LLMRequestInspector call={call} runId={runId} compact />
                    {call.response && (
                      <details>
                        <summary className="cursor-pointer hover:text-muted-foreground font-mono">Response</summary>
                        <div className="h-36 min-h-0 overflow-y-auto overflow-x-auto overscroll-contain mt-1 rounded border border-border/50 bg-muted/10 [scrollbar-gutter:stable]">
                          <pre className="block min-w-0 whitespace-pre-wrap break-words p-2 font-mono text-[10px]">{call.response}</pre>
                        </div>
                      </details>
                    )}
                  </div>
                </details>
              ))}
            </div>
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
      </Card>
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
    for (const a of ["navigator", "review", "filmstrip", "pathgen", "summary"] as const) {
      counts[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).length;
    }
    return counts;
  }, [llmCalls]);

  const agentCosts = React.useMemo(() => {
    const cost: Record<string, number> = {};
    for (const a of ["navigator", "review", "filmstrip", "pathgen", "summary"] as const) {
      cost[a] = llmCalls.filter((c) => (c.agent ?? "navigator") === a).reduce((s, c) => s + c.costUsd, 0);
    }
    return cost;
  }, [llmCalls]);

  const agentsWithCalls = (["navigator", "review", "filmstrip", "pathgen", "summary"] as const).filter((a) => agentCounts[a] > 0);

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
  const agentInfo = LLM_AGENT_CONFIG[agent];

  return (
    <Card className={cn(
      "overflow-visible transition-colors",
      agent === "navigator" && "border-l-2 border-l-emerald-500/30",
      agent === "review"    && "border-l-2 border-l-violet-500/30",
      agent === "pathgen"   && "border-l-2 border-l-amber-500/30",
      agent === "summary"   && "border-l-2 border-l-sky-500/30",
      agent === "filmstrip" && "border-l-2 border-l-fuchsia-500/30",
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
