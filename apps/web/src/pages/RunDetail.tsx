import React from "react";
import ReactMarkdown from "react-markdown";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchRunBugs, getRunStreamUrl, stopRun, patchProjectBug, createMemoryEntry } from "@/projectApi";
import { apiMediaUrl, runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { humanizeRunStep } from "@/lib/agentActivity";
import { SHOW_RUN_DEBUG } from "@/lib/debugFlag";
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
  BUG_STATUS_BADGE,
  bugStatusLabel,
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
  Lightning,
  Scroll,
  ShieldCheck,
  Link,
  ImagesSquare,
  DotsSixVertical,
  MagnifyingGlass,
  Play,
  X,
} from "@phosphor-icons/react";
import { BugRecordingClip, deriveBugClipRange } from "@/components/bug-recording-clip";

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
  | "bug_triage"
  | "crawl_link_filter"
  | "crawl_route_filter"
  | "crawl_suggested_flows"
  | "memory_curator"
  | "stagehand";

type UIAgentGroup = "navigator" | "review" | "support";

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
  /** Epoch ms when Playwright started recording — used to sync video time with step timestamps. */
  recording_started_at?: number | null;
  test_id?: string | null;
  environment?: string | null;
  project_id?: string | null;
  source_type?: "page" | "test" | "dashboard";
  source_label?: string;
  source_back_path?: string | null;
  steps_json?: RunStep[];
  activity_json?: ActivityEntry[];
  agent_plan_json?: AgentPlanItem[];
  memory_loaded?: MemoryEntryBrief[];
  bugs_json?: (RunStep & { source?: "navigator" | "review" | "network" | "filmstrip" })[];
  llm_calls_json?: LLMCallRecord[];
  /** Present while `status === "running"` when Redis live snapshot exists (see `@kery/engine` `LiveRunSnapshot`). */
  live_snapshot?: {
    agentPlan: { items: AgentPlanItem[]; at: number } | null;
    activity: ActivityEntry[];
    livePreview: { filename: string; updatedAt: number } | null;
    observability?: Record<string, unknown>;
  };
};

type Tab = "overview" | "issues" | "gallery" | "llm" | "memory";

/** Derive overview tab state from `GET /api/runs/:id` (includes merged Redis live data while running). */
function liveUiFromRun(run: Run): {
  steps: RunStep[];
  llmCalls: LLMCallRecord[];
  agentPlan: AgentPlanItem[];
  activityFeed: ActivityEntry[];
  livePreviewDisk: { filename: string; updatedAt: number } | null;
} {
  const steps = (run.steps_json ?? []) as RunStep[];
  const llmCalls = (run.llm_calls_json ?? []) as LLMCallRecord[];
  const ls = run.live_snapshot;
  let activityFeed: ActivityEntry[];
  if (ls?.activity != null && ls.activity.length > 0) {
    activityFeed = ls.activity as ActivityEntry[];
  } else if ((run.activity_json ?? []).length > 0) {
    activityFeed = run.activity_json as ActivityEntry[];
  } else {
    activityFeed = steps.map((step) => ({ type: "step" as const, step, at: step.at ?? Date.now() }));
  }
  const agentPlan = ls?.agentPlan?.items ?? (run.agent_plan_json ?? []);
  const livePreviewDisk =
    run.status === "running" && ls?.livePreview?.filename
      ? ls.livePreview
      : null;
  return { steps, llmCalls, agentPlan, activityFeed, livePreviewDisk };
}

// --- Helpers ---

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

type GalleryShot = {
  src: string;
  label: string;
  at?: number;
};

function collectGalleryShots(
  runId: string,
  steps: RunStep[],
  llmCalls: LLMCallRecord[],
  runBugs: Array<{
    screenshot_path?: string | null;
    screenshotPath?: string | null;
    screenshot_base64?: string | null;
    screenshotBase64?: string | null;
    source?: string;
    name?: string;
    step_index?: number | null;
  }>,
): Record<string, GalleryShot[]> {
  const groups: Record<string, GalleryShot[]> = {};
  const seen = new Set<string>();
  const push = (group: string, src?: string | null, label = "Frame", at?: number) => {
    if (!src) return;
    const key = `${group}:${src}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!groups[group]) groups[group] = [];
    groups[group].push({ src, label, at });
  };

  for (const s of steps) {
    const src =
      runScreenshotFileUrl(runId, s.screenshotPath ?? s.screenshot_path) ??
      screenshotRefToSrc(s.screenshotBase64 ?? s.screenshot_base64 ?? s.screenshot ?? undefined);
    push("Navigator", src, s.action || "Step", s.at);
  }

  for (const b of runBugs) {
    const src =
      runScreenshotFileUrl(runId, b.screenshot_path ?? b.screenshotPath) ??
      screenshotRefToSrc(b.screenshot_base64 ?? b.screenshotBase64 ?? undefined);
    const label = b.name ?? (b.step_index != null ? `Issue @ step ${b.step_index}` : "Issue");
    push(`Issues/${b.source ?? "review"}`, src, label);
  }

  for (const call of llmCalls) {
    const count = Math.max(
      call.imagePaths?.length ?? 0,
      call.imageBase64s?.length ?? 0,
      call.imagePath ? 1 : 0,
      call.imageBase64 ? 1 : 0,
    );
    for (let i = 0; i < count; i += 1) {
      const src = llmCallImageSrcByIndex(call, runId, i);
      const agent = llmAgentDisplay(call.agent ?? "navigator").label;
      push(agent, src, `Step ${call.stepIndex}${count > 1 ? ` (frame ${i + 1}/${count})` : ""}`);
    }
  }

  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }
  return groups;
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
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        No filmstrip images stored for this call.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/70 bg-muted/15 px-3 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Stack className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
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
              className="flex-shrink-0 w-[min(200px,72vw)] rounded-md border border-border/70 bg-card overflow-hidden"
            >
              <div className="px-2 py-1 border-b border-border/60 bg-muted/30">
                <p className="text-[9px] font-mono text-muted-foreground/80 tabular-nums">#{i + 1}</p>
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

/** Convert common LLM pseudo-list text into valid markdown for readable rendering. */
function normalizeReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const normalizedNumbered = trimmed.replace(/\s+\((\d+)\)\s+/g, "\n$1. ");
  return normalizedNumbered;
}

function llmRoleLabel(role: string): string {
  const r = role.toLowerCase();
  if (r === "system") return "System";
  if (r === "user") return "User";
  if (r === "assistant") return "Assistant";
  if (r === "tool") return "Tool";
  return role;
}

function messageTextContent(content: string | LLMStoredContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
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

type LlmAgentDisplay = {
  label: string;
  color: string;
  badgeClass: string;
  Icon: React.ComponentType<{ className?: string }>;
};

const LLM_AGENT_CONFIG: Record<LLMAgentType, LlmAgentDisplay> = {
  navigator:            { label: "Navigator",   color: "text-sky-600 dark:text-sky-400",     badgeClass: "border-sky-500/50 bg-sky-500/12 text-sky-700 dark:text-sky-300", Icon: Compass },
  review:               { label: "Review",      color: "text-violet-600 dark:text-violet-400", badgeClass: "border-violet-500/50 bg-violet-500/12 text-violet-700 dark:text-violet-300", Icon: Eye },
  holistic:             { label: "Review / Flow",       color: "text-violet-600 dark:text-violet-400", badgeClass: "border-violet-500/50 bg-violet-500/12 text-violet-700 dark:text-violet-300", Icon: GitBranch },
  summary:              { label: "Support",             color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: FileText },
  filmstrip:            { label: "Review / Filmstrip",  color: "text-violet-600 dark:text-violet-400", badgeClass: "border-violet-500/50 bg-violet-500/12 text-violet-700 dark:text-violet-300", Icon: Stack },
  bug_triage:           { label: "Support / Bug Triage",color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: WarningCircle },
  crawl_link_filter:    { label: "Support",             color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: Funnel },
  crawl_route_filter:   { label: "Support",             color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: Funnel },
  crawl_suggested_flows:{ label: "Support",             color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: FlowArrow },
  memory_curator:       { label: "Support / Memory",    color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: Brain },
  stagehand:            { label: "Support / Stagehand", color: "text-amber-600 dark:text-amber-400", badgeClass: "border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300", Icon: Lightning },
};

/** Legacy or engine-only agents (e.g. memory_curator) still render in the LLM tab. */
function llmAgentDisplay(agent: string): LlmAgentDisplay {
  const row = (LLM_AGENT_CONFIG as Record<string, LlmAgentDisplay | undefined>)[agent];
  return row ?? {
    label: agent,
    color: "text-muted-foreground",
    badgeClass: "border-border/60 bg-muted/20 text-muted-foreground",
    Icon: Brain,
  };
}

function uiAgentGroup(agent: LLMAgentType | undefined): UIAgentGroup {
  const resolved = agent ?? "navigator";
  if (resolved === "navigator") return "navigator";
  if (resolved === "review" || resolved === "holistic" || resolved === "filmstrip") return "review";
  return "support";
}

const UI_AGENT_GROUP_ORDER: UIAgentGroup[] = ["navigator", "review", "support"];

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
      screenshot_path?: string | null;
      screenshotPath?: string | null;
      screenshot_base64?: string | null;
      screenshotBase64?: string | null;
      source?: "navigator" | "review" | "network" | "filmstrip";
    }[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [liveScreenshot, setLiveScreenshot] = React.useState<string | null>(null);
  const [livePreviewDisk, setLivePreviewDisk] = React.useState<{
    filename: string;
    updatedAt: number;
  } | null>(null);
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
          const ui = liveUiFromRun(res.run);
          setSteps(ui.steps);
          setLlmCalls(ui.llmCalls);
          setAgentPlan(ui.agentPlan);
          setActivityFeed(ui.activityFeed);
          setLivePreviewDisk(ui.livePreviewDisk);
          if (res.run.status !== "running") {
            fetchRunBugs(runId!).then((r: any) => setRunBugs(r.bugs ?? []));
          }
        }
      } finally {
        setLoading(false);
      }

      if (!initialRun) return;
      if (initialRun.status === "queued") {
        pollInterval = setInterval(async () => {
          const res = await fetchRun(runId!);
          if (!res.run) return;
          setRun(res.run);
          const ui = liveUiFromRun(res.run);
          setSteps(ui.steps);
          setLlmCalls(ui.llmCalls);
          setAgentPlan(ui.agentPlan);
          setActivityFeed(ui.activityFeed);
          setLivePreviewDisk(ui.livePreviewDisk);
          if (res.run.status !== "queued" && res.run.status !== "running") {
            fetchRunBugs(runId!).then((r: any) => setRunBugs(r.bugs ?? []));
            if (pollInterval) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
          }
        }, 1000);
        return;
      }
      if (initialRun.status !== "running") return;

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
            const ui = msg.run ? liveUiFromRun(msg.run) : null;
            if (ui) {
              setSteps(ui.steps);
              setLlmCalls(ui.llmCalls);
              setAgentPlan(ui.agentPlan);
              setActivityFeed(ui.activityFeed);
            }
            setLivePreviewDisk(null);
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
            const ui = liveUiFromRun(res.run);
            setSteps(ui.steps);
            setLlmCalls(ui.llmCalls);
            setAgentPlan(ui.agentPlan);
            setActivityFeed(ui.activityFeed);
            setLivePreviewDisk(ui.livePreviewDisk);
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

  // Must be declared before any early returns so hook call order is stable
  const livePreviewDiskUrl = React.useMemo(() => {
    if (!run || run.status !== "running" || !livePreviewDisk) return null;
    const base = runScreenshotFileUrl(run.id, livePreviewDisk.filename);
    if (!base) return null;
    return `${base}?t=${livePreviewDisk.updatedAt}`;
  }, [run?.status, run?.id, livePreviewDisk]);

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
  const galleryGroups = collectGalleryShots(run.id, steps, llmCalls, runBugs);
  const galleryCount = Object.values(galleryGroups).reduce((acc, arr) => acc + arr.length, 0);

  const backUrl = run.project_id && run.source_back_path
    ? `/projects/${run.project_id}/${run.source_back_path}`
    : "/runs";
  const runTitle = (run.source_label?.trim() || run.summary?.trim() || "Run");

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full">
      {/* Back + breadcrumb + PageHeader */}
      <PageHeader
        icon={<Pulse className="h-4 w-4" />}
        title={runTitle}
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
      <div className="flex items-center gap-2 px-6 h-9 border-b border-border bg-surface-2 dark:bg-surface-3 text-[11px] flex-shrink-0">
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
        <div className="px-6 flex-shrink-0 bg-surface-2 dark:bg-surface-3">
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
            {SHOW_RUN_DEBUG && (
              <>
                <TabsTrigger value="gallery">
                  Gallery
                  {galleryCount > 0 && (
                    <span className="normal-case text-[11px] font-mono text-muted-foreground/50">{galleryCount}</span>
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
              </>
            )}
          </TabsList>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <TabsContent value="overview" className="mt-0 flex-1 min-h-0 flex flex-col overflow-hidden outline-none data-[state=inactive]:hidden">
            <OverviewTab
              run={run}
              steps={steps}
              llmCalls={llmCalls}
              bugsFound={bugsFound}
              liveScreenshot={liveScreenshot}
              livePreviewDiskUrl={livePreviewDiskUrl}
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
              onRefreshBugs={() => fetchRunBugs(run.id).then((r: any) => setRunBugs(r.bugs ?? []))}
            />
          </TabsContent>

          <TabsContent value="gallery" className="mt-0 flex-1 min-h-0 overflow-y-auto outline-none data-[state=inactive]:hidden">
            <GalleryTab groups={galleryGroups} />
          </TabsContent>

          <TabsContent value="llm" className="mt-0 flex-1 min-h-0 overflow-y-auto outline-none data-[state=inactive]:hidden">
            <LLMTab
              runId={run.id}
              llmCalls={llmCalls}
              totalCost={totalCost}
              runStatus={run.status}
              activityFeed={activityFeed}
            />
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
              <span className="text-foreground/90">Filmstrip</span> — post-run visual journey across visited routes
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
  const rows = UI_AGENT_GROUP_ORDER
    .map((group) => ({
      agent: group,
      cost: llmCalls.filter((c) => uiAgentGroup(c.agent) === group).reduce((s, c) => s + c.costUsd, 0),
      calls: llmCalls.filter((c) => uiAgentGroup(c.agent) === group).length,
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
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{llmAgentDisplay(r.agent as LLMAgentType).label}</p>
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

// ============================================================
// Step timeline (Progress tab)
// ============================================================

type StepTimelineEntry = RunStep & { relativeMs: number };

function stepActionLabel(action: string): string {
  const map: Record<string, string> = {
    click: "Click",
    fill: "Fill",
    navigate: "Navigate",
    back: "Back",
    scroll: "Scroll",
    hover: "Hover",
    pressKey: "Key",
    selectOption: "Select",
    setDate: "Date",
    assert: "Assert",
    observe: "Observe",
    plan: "Plan",
    auth: "Auth",
    bug: "Bug",
    wait: "Wait",
    dragAndDrop: "Drag",
    done: "Done",
  };
  return map[action] ?? action;
}

function stepActionColor(action: string): string {
  if (["click", "hover", "dragAndDrop"].includes(action)) return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20";
  if (["fill", "pressKey", "selectOption", "setDate"].includes(action)) return "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20";
  if (["navigate", "back"].includes(action)) return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/20";
  if (action === "assert") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  if (action === "auth") return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20";
  if (action === "bug") return "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20";
  if (action === "done") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  return "bg-muted/60 text-muted-foreground border-border/40";
}

function StepCard({
  entry,
  timelineEntry,
  isReplayCurrent,
  replayActiveStepRef,
  stepNumber,
}: {
  entry: { type: "step"; at: number; step: RunStep };
  timelineEntry?: StepTimelineEntry;
  isReplayCurrent: boolean;
  replayActiveStepRef: React.RefObject<HTMLDivElement | null>;
  stepNumber: number;
}) {
  const { step } = entry;
  const h = humanizeRunStep(step);
  const isFailed = step.status === "failed";
  const isAuth = step.action === "auth";

  const detail = step.target ?? step.value ?? step.assertion ?? step.reasoning;

  return (
    <div
      ref={isReplayCurrent ? (replayActiveStepRef as React.RefObject<HTMLDivElement>) : undefined}
      className={cn(
        "group relative rounded-lg border px-3 py-2.5 transition-colors duration-150 animate-slide-up",
        isFailed
          ? "border-red-500/40 bg-red-500/5 dark:bg-red-500/8"
          : isReplayCurrent
            ? "border-border bg-accent/25 ring-2 ring-ring/20"
            : "border-border/60 bg-surface-2 dark:bg-surface-3 hover:border-border hover:bg-surface-2 dark:hover:bg-surface-3",
      )}
    >
      {isReplayCurrent && (
        <span className="absolute left-1.5 top-1.5 bottom-1.5 w-[2px] rounded-full bg-ring/55" aria-hidden />
      )}
      <div className="flex items-start gap-2.5">
        {/* Step number + status indicator */}
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          <div
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold",
              isFailed
                ? "bg-red-500/20 text-red-600 dark:text-red-400"
                : "bg-muted/60 text-muted-foreground",
            )}
          >
            {stepNumber}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {/* Header row: action badge + title + time */}
          <div className="flex flex-wrap items-center gap-1.5">
            {isAuth ? (
              <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none", stepActionColor("auth"))}>
                <ShieldCheck className="h-2.5 w-2.5" />
                Auth
              </span>
            ) : (
              <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none", stepActionColor(step.action))}>
                {stepActionLabel(step.action)}
              </span>
            )}
            <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{h.title}</p>
            {timelineEntry && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                {formatMs(timelineEntry.relativeMs)}
              </span>
            )}
          </div>

          {/* Detail line */}
          {detail && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
          )}

          {/* Error line */}
          {isFailed && step.error && (
            <p className="mt-1 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-600 dark:text-red-400">
              {step.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StepTimeline({
  activityFeed,
  stepTimeline,
  replayCurrentIndex,
  replayActiveStepRef,
}: {
  activityFeed: ActivityEntry[];
  stepTimeline: StepTimelineEntry[];
  replayCurrentIndex: number;
  replayActiveStepRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (activityFeed.length === 0) {
    return <p className="pt-2 text-[12px] text-muted-foreground">No steps yet.</p>;
  }

  // Group consecutive steps by URL
  const groups: { url: string | null; entries: typeof activityFeed }[] = [];
  for (const entry of activityFeed) {
    const url = entry.type === "step" ? (entry.step.url ?? null) : null;
    const last = groups[groups.length - 1];
    if (!last || last.url !== url) {
      groups.push({ url, entries: [entry] });
    } else {
      last.entries.push(entry);
    }
  }

  let globalStepIdx = 0;

  return (
    <div className="space-y-3 pr-1 pt-1">
      {groups.map((group, gi) => {
        const urlLabel = group.url
          ? (() => { try { return new URL(group.url).pathname || group.url; } catch { return group.url; } })()
          : null;

        return (
          <div key={gi}>
            {/* URL section header */}
            {urlLabel && (
              <div className="mb-1.5 flex items-center gap-1.5 px-1">
                <Link className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                <span className="truncate font-mono text-[10px] text-muted-foreground/70">{urlLabel}</span>
              </div>
            )}

            <div className="space-y-1.5">
              {group.entries.map((entry, ei) => {
                if (entry.type !== "step") {
                  // Inline observe / plan note
                  return (
                    <div
                      key={`${entry.type}-${entry.at}-${ei}`}
                      className="flex items-center gap-2 px-1 py-0.5"
                    >
                      {entry.type === "activity" ? (
                        <Eye className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      ) : (
                        <Path className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      )}
                      <p className="truncate text-[10px] text-muted-foreground/70">
                        {entry.type === "activity" ? entry.activity.text : `Plan updated (${entry.items.length} items)`}
                      </p>
                    </div>
                  );
                }

                const stepNum = ++globalStepIdx;
                const timelineEntry = stepTimeline.find((s) => s.index === entry.step.index);
                const isReplayCurrent =
                  timelineEntry != null && replayCurrentIndex >= 0
                    ? stepTimeline[replayCurrentIndex]?.index === timelineEntry.index
                    : false;

                return (
                  <StepCard
                    key={`step-${entry.step.index}-${entry.at}-${ei}`}
                    entry={entry}
                    timelineEntry={timelineEntry}
                    isReplayCurrent={isReplayCurrent}
                    replayActiveStepRef={replayActiveStepRef}
                    stepNumber={stepNum}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
              "relative z-[1] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out",
              isCurrent && "bg-muted/40",
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
              className="mt-1 min-h-[10px] w-px flex-1 bg-border/40"
              aria-hidden
            />
          )}
        </div>
        <div
          className={cn(
            "min-w-0 flex-1 pb-3 transition-colors duration-150 ease-out",
            isCurrent && "plan-current-underline",
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

/** Clean browser preview stage — no wallpaper. */
function BrowserPreviewStage({
  children,
  empty,
  liveFrameOpenAnim,
  onLiveFrameOpenAnimEnd,
}: {
  children: React.ReactNode;
  empty?: boolean;
  liveFrameOpenAnim?: boolean;
  onLiveFrameOpenAnimEnd?: () => void;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20 dark:bg-surface-2/50 p-3">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50",
          empty && "items-center justify-center bg-muted/30 dark:bg-muted/15",
          liveFrameOpenAnim && "run-preview-window-open-anim",
        )}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (!e.animationName.includes("run-preview-window-open")) return;
          onLiveFrameOpenAnimEnd?.();
        }}
      >
        {!empty && (
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-muted/20 dark:bg-surface-2/40" aria-hidden />
        )}
        <div className="relative z-[1] flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{children}</div>
      </div>
    </div>
  );
}

function OverviewTab({
  run, steps, llmCalls, bugsFound, liveScreenshot, livePreviewDiskUrl, totalCost, agentPlan, activityFeed,
}: {
  run: Run;
  steps: RunStep[];
  llmCalls: LLMCallRecord[];
  bugsFound: RunStep[];
  liveScreenshot: string | null;
  /** Throttled on-disk live frame from Redis rehydrate (`/api/bugs/:runId/live-preview.jpg?t=…`). */
  livePreviewDiskUrl: string | null;
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

  // Oldest-first ordered step entries (non-steps collapsed into timeline)
  const activityOldestFirst = React.useMemo(
    () => [...activityFeed],
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
    // Try the last step that has a screenshot reference first.
    const lastWithScreenshot = [...steps]
      .reverse()
      .find((s) =>
        s.screenshotPath || s.screenshot_path || s.screenshotBase64 || s.screenshot_base64 || s.screenshot,
      );
    if (lastWithScreenshot) {
      const fileUrl = runScreenshotFileUrl(run.id, lastWithScreenshot.screenshotPath ?? lastWithScreenshot.screenshot_path);
      const legacyRef =
        lastWithScreenshot.screenshotBase64 ?? lastWithScreenshot.screenshot_base64 ?? lastWithScreenshot.screenshot;
      const src = fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined) ?? null;
      if (src) return src;
    }
    // Fall back to the last navigator LLM call that has a vision screenshot — this matches
    // what the Gallery tab shows and ensures the overview is in parity with it.
    const navCallsWithImages = llmCalls.filter(
      (c) =>
        (c.agent === "navigator" || c.agent == null) &&
        c.hasVision &&
        (c.imagePaths?.length || c.imageBase64s?.length || c.imagePath || c.imageBase64),
    );
    if (navCallsWithImages.length > 0) {
      const last = navCallsWithImages[navCallsWithImages.length - 1];
      return llmCallImageSrcByIndex(last, run.id, 0) ?? null;
    }
    return null;
  }, [steps, llmCalls, run.id]);

  const showLive = run.status === "running" && !!liveScreenshot;
  const showLiveDisk = run.status === "running" && !liveScreenshot && !!livePreviewDiskUrl;
  // Don't show the "launching" spinner if we already have an LLM screenshot to display —
  // snapshotSrc falls back to the latest navigator vision call (same source as the gallery).
  const isRunStarting = run.status === "running" && !liveScreenshot && !showLiveDisk && !snapshotSrc;
  const showRecording = !showLive && !showLiveDisk && !!run.video_url;
  const previewEmpty = !isRunStarting && !showLive && !showLiveDisk && !showRecording && !snapshotSrc;
  const [liveFrameOpenAnim, setLiveFrameOpenAnim] = React.useState(false);
  const seenLivePreviewRef = React.useRef(false);
  const recordingVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const [playbackMs, setPlaybackMs] = React.useState(0);
  const [videoDurationMs, setVideoDurationMs] = React.useState(0);
  const replayActiveStepRef = React.useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = React.useState(288);
  const isDragging = React.useRef(false);
  const dragStartX = React.useRef(0);
  const dragStartWidth = React.useRef(0);

  const onDragHandleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - ev.clientX;
      const next = Math.max(180, Math.min(520, dragStartWidth.current + delta));
      setPanelWidth(next);
    };
    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);
  const stepTimeline = React.useMemo(() => {
    const timed = steps
      .filter((s): s is RunStep & { at: number } => typeof s.at === "number")
      .sort((a, b) => a.at - b.at);
    if (timed.length === 0) return [];
    // Use recording_started_at (epoch ms when Playwright started recording) as the video origin so that
    // video currentTime (seconds since recording start) maps correctly to step timestamps.
    // Fall back to first step time if not available.
    const videoOriginMs = run.recording_started_at
      ? run.recording_started_at
      : timed[0].at;
    return timed.map((s) => ({ ...s, relativeMs: Math.max(0, s.at - videoOriginMs) }));
  }, [steps, run.recording_started_at]);
  const replayCursorRelativeMs = React.useMemo(() => {
    if (stepTimeline.length === 0) return playbackMs;
    if (videoDurationMs <= 0) return playbackMs;
    const first = stepTimeline[0].relativeMs;
    const last = stepTimeline[stepTimeline.length - 1].relativeMs;
    if (last <= first) return playbackMs;
    const ratio = Math.max(0, Math.min(1, playbackMs / videoDurationMs));
    return first + ratio * (last - first);
  }, [stepTimeline, playbackMs, videoDurationMs]);
  const hasPlan = agentPlan.length > 0;
  const [rightTab, setRightTab] = React.useState<"plan" | "progress">(hasPlan ? "plan" : "progress");

  React.useEffect(() => {
    if (!hasPlan && rightTab === "plan") setRightTab("progress");
  }, [hasPlan, rightTab]);

  const replayCurrentIndex = React.useMemo(() => {
    if (stepTimeline.length === 0) return -1;
    const hasDistinctTimes = stepTimeline.some((s, i) => i > 0 && s.relativeMs > stepTimeline[i - 1].relativeMs);
    if (!hasDistinctTimes && videoDurationMs > 0) {
      const ratio = Math.max(0, Math.min(1, playbackMs / videoDurationMs));
      const proportional = Math.floor(ratio * stepTimeline.length);
      return Math.max(0, Math.min(stepTimeline.length - 1, proportional));
    }
    let idx = -1;
    for (let i = 0; i < stepTimeline.length; i += 1) {
      if (stepTimeline[i].relativeMs <= replayCursorRelativeMs) idx = i;
      else break;
    }
    return idx;
  }, [stepTimeline, playbackMs, replayCursorRelativeMs, videoDurationMs]);
  const replayCurrentPlanIndex = React.useMemo(() => {
    if (stepTimeline.length === 0 || agentPlan.length === 0) return null;
    const planEvents = activityOldestFirst
      .filter((e): e is { type: "plan"; at: number; items: AgentPlanItem[] } => e.type === "plan")
      .sort((a, b) => a.at - b.at);
    if (planEvents.length === 0) return null;
    const videoOriginMs = run.recording_started_at ? run.recording_started_at : stepTimeline[0].at;
    const playbackAtEpoch = videoOriginMs + replayCursorRelativeMs;
    let lastPlan: AgentPlanItem[] | null = null;
    for (const ev of planEvents) {
      if (ev.at <= playbackAtEpoch) lastPlan = ev.items;
      else break;
    }
    if (!lastPlan) {
      if (videoDurationMs > 0 && agentPlan.length > 0) {
        const ratio = Math.max(0, Math.min(1, playbackMs / videoDurationMs));
        return Math.max(0, Math.min(agentPlan.length - 1, Math.floor(ratio * agentPlan.length)));
      }
      return null;
    }
    const idx = lastPlan.findIndex((i) => i.status === "current");
    if (idx >= 0) return idx;
    if (videoDurationMs > 0 && agentPlan.length > 0) {
      const ratio = Math.max(0, Math.min(1, playbackMs / videoDurationMs));
      return Math.max(0, Math.min(agentPlan.length - 1, Math.floor(ratio * agentPlan.length)));
    }
    return null;
  }, [stepTimeline, agentPlan.length, activityOldestFirst, run.recording_started_at, playbackMs, replayCursorRelativeMs, videoDurationMs]);
  const canReplay = showRecording && stepTimeline.length > 0;
  const displayStep = React.useMemo(() => {
    if (canReplay && replayCurrentIndex >= 0) {
      return stepTimeline[replayCurrentIndex] ?? latestStep;
    }
    return latestStep;
  }, [canReplay, replayCurrentIndex, stepTimeline, latestStep]);
  const displayStepHumanized = displayStep ? humanizeRunStep(displayStep) : null;
  const displayStepReasoning = (displayStep?.reasoning ?? "").trim();
  const displayActionLabel = displayStepHumanized?.title ?? "Waiting for activity...";
  const statusPrimaryText = React.useMemo(() => {
    if (run.status === "running" && latestEntry?.type === "activity") return latestEntry.activity.text;
    return displayStepReasoning || displayActionLabel;
  }, [run.status, latestEntry, displayStepReasoning, displayActionLabel]);
  const latestReasoningMarkdown = React.useMemo(
    () => normalizeReasoningMarkdown(statusPrimaryText),
    [statusPrimaryText],
  );

  React.useEffect(() => {
    if (replayCurrentIndex >= 0 && replayActiveStepRef.current) {
      replayActiveStepRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [replayCurrentIndex]);

  React.useLayoutEffect(() => {
    if ((showLive || showLiveDisk) && !seenLivePreviewRef.current) {
      seenLivePreviewRef.current = true;
      setLiveFrameOpenAnim(true);
    }
    if (!showLive && !showLiveDisk) {
      seenLivePreviewRef.current = false;
      setLiveFrameOpenAnim(false);
    }
  }, [showLive, showLiveDisk]);

  React.useEffect(() => {
    if (!liveFrameOpenAnim) return;
    const id = window.setTimeout(() => setLiveFrameOpenAnim(false), 700);
    return () => window.clearTimeout(id);
  }, [liveFrameOpenAnim]);

  React.useEffect(() => {
    if (!canReplay) return;
    const node = recordingVideoRef.current;
    if (!node) return;
    node.currentTime = 0;
    setPlaybackMs(0);
    void node.play().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReplay]);

  return (
    /* flex-row: video grows left, resizable panel is a fixed-width column on the right */
    <div className="flex flex-row flex-1 min-h-0 overflow-hidden">

      {/* ── Video column — fills all remaining width ── */}
      <div className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
        <BrowserPreviewStage
          empty={previewEmpty}
          liveFrameOpenAnim={liveFrameOpenAnim}
          onLiveFrameOpenAnimEnd={() => setLiveFrameOpenAnim(false)}
        >
          {isRunStarting ? (
            <div className="flex h-full w-full items-center justify-center">
              <div className="flex max-w-[min(100%,22rem)] items-center gap-2 rounded-lg border border-border/70 bg-card/92 px-3 py-2 backdrop-blur-[2px]">
                <Spinner className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" weight="bold" />
                <p className="font-display text-[11px] font-medium leading-snug tracking-tight text-foreground">
                  Launching a browser for this run...
                </p>
              </div>
            </div>
          ) : showLive ? (
            <img src={`data:image/jpeg;base64,${liveScreenshot}`} alt="Live browser" className="h-full w-full min-h-0 flex-1 object-contain" />
          ) : showLiveDisk ? (
            <img src={livePreviewDiskUrl!} alt="Live browser" className="h-full w-full min-h-0 flex-1 object-contain" />
          ) : showRecording ? (
            <video
              ref={recordingVideoRef}
              src={apiMediaUrl(run.video_url!)}
              controls
              className="h-full w-full min-h-0 flex-1 object-contain"
              preload="metadata"
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                setVideoDurationMs(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0);
              }}
              onTimeUpdate={(e) => setPlaybackMs(Math.round(e.currentTarget.currentTime * 1000))}
              onSeeking={(e) => setPlaybackMs(Math.round(e.currentTarget.currentTime * 1000))}
              onSeeked={(e) => setPlaybackMs(Math.round(e.currentTarget.currentTime * 1000))}
            />
          ) : snapshotSrc ? (
            <img src={snapshotSrc} alt="Run browser preview" className="h-full w-full min-h-0 flex-1 object-contain" />
          ) : (
            <p className="px-4 text-center text-[12px] text-muted-foreground">No preview yet</p>
          )}
        </BrowserPreviewStage>

        {/* Live indicator — small pill in video corner */}
        {(showLive || showLiveDisk || (run.status === "running" && !!snapshotSrc)) && (
          <div className="pointer-events-none absolute left-5 top-5 z-20 flex items-center gap-1.5 rounded-full border border-border/50 bg-card/90 px-2 py-1 backdrop-blur-[4px]">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            <span className="text-[10px] font-medium text-foreground/80">live</span>
          </div>
        )}
      </div>

      {/* ── Drag-to-resize handle ── */}
      <div
        onMouseDown={onDragHandleMouseDown}
        className="w-5 flex-shrink-0 cursor-col-resize group relative z-10 transition-colors bg-surface-2/55 hover:bg-surface-2"
        title="Drag to resize"
      >
        <div className="absolute inset-y-1 left-1/2 -translate-x-1/2 w-[2px] rounded-full bg-border group-hover:bg-ring/70 transition-colors" />
        <div className="absolute inset-0 grid place-items-center opacity-70 group-hover:opacity-100 transition-opacity">
          <DotsSixVertical className="h-4.5 w-4.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        </div>
      </div>

      {/* ── Plan / Progress panel — resizable column ── */}
      <div
        className="flex-shrink-0 flex flex-col min-h-0 overflow-hidden border-l border-border bg-surface-1 dark:bg-surface-2"
        style={{ width: panelWidth }}
      >
        <>
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-surface-2 dark:bg-surface-3 flex-shrink-0">
            <div className="flex items-center gap-1 rounded-md border border-border bg-surface-1 dark:bg-surface-2 p-0.5">
              {hasPlan && (
                <button
                  type="button"
                  onClick={() => setRightTab("plan")}
                  className={cn(
                    "h-6 rounded px-2.5 text-[11px] transition-colors",
                    rightTab === "plan" ? "bg-foreground/10 dark:bg-white/12 text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Plan
                </button>
              )}
              <button
                type="button"
                onClick={() => setRightTab("progress")}
                className={cn(
                  "h-6 rounded px-2.5 text-[11px] transition-colors",
                  rightTab === "progress" ? "bg-foreground/10 dark:bg-white/12 text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Progress
              </button>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate">
              {steps.length}s · {formatCost(totalCost)}
            </span>
          </div>

            {/* Body */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-3 gap-3">
              {rightTab === "plan" ? (
                <>
                  {planProgress && planProgress.n > 0 && (
                    <div className="h-1 overflow-hidden rounded-full bg-foreground/10 flex-shrink-0">
                      <div
                        className="plan-progress-glow h-full rounded-full bg-primary/60 transition-[width] duration-200 ease-out"
                        style={{ width: `${planProgress.pct}%` }}
                      />
                    </div>
                  )}
                  <div className="min-h-0 flex-1 basis-0 overflow-y-auto overflow-x-hidden pr-1 pb-0.5 [scrollbar-gutter:stable] touch-pan-y overscroll-contain">
                    {agentPlan.length === 0 ? (
                      <p className="text-[12px] text-muted-foreground">No plan captured for this run.</p>
                    ) : (
                      <ol className="m-0 list-none p-0">
                        {agentPlan.map((item, idx) => {
                          const replayStatus =
                            run.status !== "running" && canReplay && replayCurrentPlanIndex != null
                              ? (idx < replayCurrentPlanIndex ? "done" : idx === replayCurrentPlanIndex ? "current" : "pending")
                              : item.status;
                          return (
                            <PlanChecklistRow
                              key={`${idx}-${item.text.slice(0, 96)}`}
                              item={{ ...item, status: replayStatus }}
                              isLast={idx === agentPlan.length - 1}
                            />
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-2 dark:bg-surface-3 px-3 py-2.5 flex-shrink-0">
                    {run.status === "running" ? (
                      <Spinner className="mt-0.5 h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                    ) : (
                      <CheckCircle className="mt-0.5 h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="min-w-0 text-[12px] font-medium leading-snug text-foreground break-words space-y-1">
                        <ReactMarkdown
                          components={{
                            p: ({ children }) => <p className="whitespace-pre-wrap break-words mb-1">{children}</p>,
                            strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                            em: ({ children }) => <em className="italic text-foreground/90">{children}</em>,
                            code: ({ children }) => <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">{children}</code>,
                            ul: ({ children }) => <ul className="list-disc space-y-0.5 pl-4">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal space-y-0.5 pl-4">{children}</ol>,
                            li: ({ children }) => <li className="leading-snug">{children}</li>,
                          }}
                        >
                          {latestReasoningMarkdown}
                        </ReactMarkdown>
                      </div>
                      {(run.status !== "running" || latestEntry?.type !== "activity") && (
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {displayActionLabel}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 basis-0 overflow-y-auto overflow-x-hidden pb-0.5 [scrollbar-gutter:stable] touch-pan-y overscroll-contain">
                    <StepTimeline
                      activityFeed={activityOldestFirst}
                      stepTimeline={stepTimeline}
                      replayCurrentIndex={replayCurrentIndex}
                      replayActiveStepRef={replayActiveStepRef}
                    />
                  </div>
                </>
              )}
            </div>
          </>
      </div>
    </div>
  );
}

// ============================================================
// Gallery tab
// ============================================================

function GalleryTab({ groups }: { groups: Record<string, GalleryShot[]> }) {
  const [query, setQuery] = React.useState("");
  const entries = Object.entries(groups).filter(([group, shots]) => {
    if (shots.length === 0) return false;
    const g = group.toLowerCase();
    return g === "navigator" || g.startsWith("issues/");
  });

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<ImagesSquare className="h-5 w-5" />}
        title="No screenshots captured"
        description="This run has no stored gallery frames yet."
        className="py-16"
      />
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = entries
    .map(([group, shots]) => ({
      group,
      shots: q ? shots.filter(s => s.label.toLowerCase().includes(q) || group.toLowerCase().includes(q)) : shots,
    }))
    .filter(({ shots }) => shots.length > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-border">
        <div className="relative">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter screenshots…"
            className="h-8 w-full rounded-md border border-border bg-surface-2 dark:bg-surface-3 pl-8 pr-8 text-[12px] outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {filtered.length === 0 ? (
          <p className="text-center py-12 text-[12px] text-muted-foreground">No screenshots match &ldquo;{query}&rdquo;</p>
        ) : (
          filtered.map(({ group, shots }) => (
            <div key={group}>
              {/* Section header */}
              <div className="flex items-center gap-3 mb-3">
                <div className="h-px flex-1 bg-border" />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</span>
                  <span className="text-[10px] font-mono text-muted-foreground/50 bg-surface-2 dark:bg-surface-3 border border-border rounded px-1.5 py-0.5">{shots.length}</span>
                </div>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                {shots.map((shot, idx) => (
                  <div key={`${group}-${idx}`} className="glass-card-flat flex flex-col overflow-hidden">
                    <div className="flex-1 min-h-0">
                      <BugScreenshotZoomDialog src={shot.src} thumbnailClassName="w-full h-[140px] object-cover" triggerClassName="w-full rounded-none border-0" />
                    </div>
                    <div className="px-2 py-1.5 bg-surface-2 dark:bg-surface-3 border-t glass-divider flex-shrink-0">
                      <p className="truncate text-[11px] text-muted-foreground" title={shot.label}>{shot.label}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// Run triage banner — appears above issue list when bugs need review
// ============================================================

function RunTriageBanner({
  runBugs,
  projectId,
  onRefreshBugs,
}: {
  runBugs: { id?: string; status?: string }[];
  projectId?: string;
  onRefreshBugs?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = React.useState(false);
  const untriaged = runBugs.filter((b) => b.status === "open" && b.id);
  if (untriaged.length === 0 || !projectId) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-2 flex-shrink-0">
      <span className="text-[11px] text-foreground flex-1 min-w-0">
        <span className="font-medium">{untriaged.length}</span> bug{untriaged.length === 1 ? "" : "s"} need review
      </span>
      <button
        type="button"
        className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await Promise.all(
              untriaged.map((b) => patchProjectBug(projectId, b.id!, { status: "in_progress" })),
            );
            await onRefreshBugs?.();
          } finally {
            setBusy(false);
          }
        }}
      >
        Mark all for fix
      </button>
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
  onRefreshBugs,
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
  onRefreshBugs?: () => Promise<void> | void;
}) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  React.useEffect(() => {
    if (bugsFound.length === 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= bugsFound.length) setSelectedIndex(0);
  }, [bugsFound.length, selectedIndex]);

  const selectedBug = bugsFound[selectedIndex] ?? null;

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full animate-fade-in">
      {bugsFound.length === 0 ? (
        <div className="px-6 py-5 max-w-4xl w-full mx-auto">
          <EmptyState
            icon={<WarningCircle className="h-5 w-5" />}
            title="No issues"
            description="Nothing was reported for this run. Check the Overview for live activity and LLM Calls for audit detail."
          />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="w-[340px] flex-shrink-0 flex flex-col min-h-0 border-r border-border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0 bg-surface-2 dark:bg-surface-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Issues</span>
              <span className="text-[11px] font-mono text-muted-foreground/60">{bugsFound.length}</span>
            </div>
            <RunTriageBanner runBugs={runBugs} projectId={projectId} onRefreshBugs={onRefreshBugs} />
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
              {bugsFound.map((bug: RunStep & { name?: string }, i: number) => {
                const displayName = runJsonBugDisplayName(bug);
                const category = String(bug.category ?? bug.bugType ?? "other");
                const dbBug = resolveRunDbBug(bug, runBugs);
                const reportedIso = dbBug?.reported_at ?? run.completed_at ?? run.started_at ?? "";
                const selected = i === selectedIndex;
                return (
                  <button key={i} type="button" onClick={() => setSelectedIndex(i)} className="w-full text-left block">
                    <div className={cn("glass-card-flat p-2.5 transition-all", selected && "ring-2 ring-ring/20 border-border bg-accent/25")}>
                      <div className="flex items-center gap-2">
                        <StatusDot status={(bug.severity ? BUG_SEVERITY_STATUS_DOT[bug.severity] : undefined) ?? "stale"} />
                        <span className="text-[13px] font-medium text-foreground truncate flex-1 min-w-0">{displayName}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <BugCategoryTag category={category} />
                        {dbBug?.status && (
                          <Badge variant={BUG_STATUS_BADGE[dbBug.status] ?? "neutral"} className="capitalize text-[10px]">
                            {dbBug.status.replace("_", " ")}
                          </Badge>
                        )}
                        <span className="ml-auto text-[10px] font-mono text-muted-foreground/60">
                          {reportedIso ? formatReportedAt(reportedIso) : "—"}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
            {selectedBug && (
              <BugCard bug={selectedBug} runBugs={runBugs} runId={run.id} projectId={projectId} run={run} forceExpanded onRefreshBugs={onRefreshBugs} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function resolveRunDbBug(
  bug: any,
  runBugs: {
    id?: string;
    name: string;
    description: string;
    url?: string | null;
    step_index?: number | null;
    status?: string;
    reported_at?: string;
    screenshot_path?: string | null;
  }[],
) {
  const nameNorm = (bug.name ?? "").trim();
  const bodyNorm = (bug.description ?? bug.reasoning ?? "").trim();
  return runBugs.find(
    (b) =>
      (typeof bug.index === "number" && b.step_index != null && b.step_index === bug.index) ||
      (b.name.trim() === nameNorm && b.description.trim() === bodyNorm) ||
      (b.description.trim() === bodyNorm && (b.url ?? "").trim() === (bug.url ?? "").trim()),
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
  forceExpanded = false,
  onRefreshBugs,
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
    screenshot_path?: string | null;
  }[];
  runId: string;
  projectId?: string;
  run: Run;
  forceExpanded?: boolean;
  onRefreshBugs?: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const displayName = runJsonBugDisplayName(bug);
  const detail = runJsonBugDetailDescription(bug, displayName);
  const category = String(bug.category ?? bug.bugType ?? "other");

  const dbBug = resolveRunDbBug(bug, runBugs);
  const reportedIso = dbBug?.reported_at ?? run.completed_at ?? run.started_at ?? "";
  const isExpanded = forceExpanded || expanded;

  // Sync local status with the latest dbBug.status whenever runBugs refreshes
  const [bugStatus, setBugStatus] = React.useState<string | undefined>(dbBug?.status);
  React.useEffect(() => {
    setBugStatus(dbBug?.status);
  }, [dbBug?.status]);
  const isOpen = !bugStatus || bugStatus === "open" || bugStatus === "in_progress";

  async function markForFix() {
    if (!projectId || !dbBug?.id || !isOpen) return;
    setBusy(true);
    try {
      await patchProjectBug(projectId, dbBug.id, { status: "in_progress" });
      setBugStatus("in_progress");
      await onRefreshBugs?.();
    } finally {
      setBusy(false);
    }
  }

  async function ignoreIssue() {
    if (!projectId || !dbBug?.id || !isOpen) return;
    setBusy(true);
    try {
      await patchProjectBug(projectId, dbBug.id, { status: "wont_fix" });
      const bodyForMemory = detail || (bug.description ?? bug.reasoning ?? "").trim();
      await createMemoryEntry(projectId, {
        type: "ignore_region",
        summary: `Ignored issue: ${displayName}`,
        content: `${bodyForMemory}\n\n${bug.url ? `URL: ${bug.url}` : ""}`.trim(),
        confidence: 100,
      });
      setBugStatus("wont_fix");
      await onRefreshBugs?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden transition-colors",
        forceExpanded
          ? "flex h-full flex-col"
          : cn("rounded-lg border border-border bg-card", isExpanded && "ring-1 ring-border"),
      )}
    >
      {!forceExpanded && (
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
          {bugStatus && (
            <Badge
              variant={BUG_STATUS_BADGE[bugStatus] ?? "neutral"}
              className="flex-shrink-0 text-[10px]"
            >
              {bugStatusLabel(bugStatus)}
            </Badge>
          )}
          <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0 tabular-nums">
            {reportedIso ? formatReportedAt(reportedIso) : "—"}
          </span>
        </button>
      )}

      {isExpanded && forceExpanded && (() => {
        // Prefer dbBug.screenshot_path (UUID-named, from bugs table) over bugs_json path (stale bug-N.jpg)
        const screenshotPath = dbBug?.screenshot_path ?? bug.screenshotPath ?? bug.screenshot_path;
        const fileUrl = runScreenshotFileUrl(runId, screenshotPath);
        const legacyRef = bug.screenshotBase64 ?? bug.screenshot_base64 ?? bug.screenshot;
        const screenshotSrc = fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined);
        const stepIndex = dbBug?.step_index ?? (typeof bug.index === "number" ? bug.index : null);
        const clipRange = run.video_url
          ? deriveBugClipRange(run.steps_json ?? [], run.recording_started_at ?? null, stepIndex)
          : null;
        const videoUrl = run.video_url ? apiMediaUrl(run.video_url) : null;

        return (
          <div className="flex flex-col animate-fade-in">
            {/* Header — title left, actions right */}
            <div className="flex-shrink-0 border-b border-border px-5 py-3 bg-surface-2 dark:bg-surface-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-foreground leading-snug truncate">
                  {displayName}
                </h2>
                {projectId && dbBug?.id && isOpen && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 px-3 text-[11px]"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); markForFix(); }}
                    >
                      Mark for fix
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-3 text-[11px]"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); ignoreIssue(); }}
                    >
                      Ignore
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Hero — screenshot + recording */}
            {(screenshotSrc || (clipRange && videoUrl)) && (
              <div className="border-b border-border bg-surface-2 dark:bg-surface-3 px-6 py-5">
                <div className={cn(
                  "mx-auto grid w-full max-w-4xl gap-4",
                  screenshotSrc && clipRange && videoUrl ? "md:grid-cols-2" : "grid-cols-1",
                )}>
                  {screenshotSrc && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <BugScreenshotZoomDialog
                        src={screenshotSrc}
                        triggerClassName="w-full"
                        thumbnailClassName="w-full max-h-[400px] object-contain"
                      />
                    </div>
                  )}
                  {clipRange && videoUrl && (
                    <BugRecordingClip
                      videoUrl={videoUrl}
                      startSec={clipRange.startSec}
                      endSec={clipRange.endSec}
                      posterSrc={screenshotSrc ?? undefined}
                      bugName={displayName}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="px-6 py-5 space-y-4">
              {/* Description */}
              {detail && (
                <section>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-2">
                    Description
                  </p>
                  <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">{detail}</p>
                </section>
              )}

              {/* Additional info */}
              <section className="border-t border-border pt-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-3">
                  Additional info
                </p>
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <BugCategoryTag category={category} />
                    {dbBug?.status && (
                      <Badge variant={BUG_STATUS_BADGE[dbBug.status] ?? "neutral"} className="text-[10px]">
                        {bugStatusLabel(dbBug.status)}
                      </Badge>
                    )}
                  </div>
                  {run.environment && (
                    <div className="flex items-center gap-2">
                      <ComputerTower className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0">Environment</span>
                      <span className="text-[12px] text-muted-foreground">{run.environment}</span>
                    </div>
                  )}
                  {reportedIso && (
                    <div className="flex items-center gap-2">
                      <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0">Detected</span>
                      <span className="text-[12px] font-mono text-muted-foreground">{new Date(reportedIso).toLocaleString()}</span>
                    </div>
                  )}
                  {bug.url && (
                    <div className="flex items-start gap-2 min-w-0">
                      <Globe className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 mt-0.5" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 w-20 shrink-0 mt-0.5">URL</span>
                      <a
                        href={bug.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 min-w-0 text-[12px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="truncate">{bug.url}</span>
                        <ArrowSquareOut className="h-3 w-3 flex-shrink-0 opacity-50" />
                      </a>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        );
      })()}

      {isExpanded && !forceExpanded && (
        <div className="px-4 py-4 space-y-4 animate-fade-in border-t border-border bg-muted/10">
          {detail ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5">
                Description
              </p>
              <p className="text-[13px] text-foreground whitespace-pre-wrap">{detail}</p>
            </div>
          ) : null}

          {(() => {
            const screenshotPath = dbBug?.screenshot_path ?? bug.screenshotPath ?? bug.screenshot_path;
            const fileUrl = runScreenshotFileUrl(runId, screenshotPath);
            const legacyRef = bug.screenshotBase64 ?? bug.screenshot_base64 ?? bug.screenshot;
            const screenshotSrc = fileUrl ?? screenshotRefToSrc(legacyRef ?? undefined);
            const stepIndex = dbBug?.step_index ?? (typeof bug.index === "number" ? bug.index : null);
            const clipRange = run.video_url
              ? deriveBugClipRange(run.steps_json ?? [], run.recording_started_at ?? null, stepIndex)
              : null;
            const videoUrl = run.video_url ? apiMediaUrl(run.video_url) : null;
            if (!screenshotSrc && !clipRange) return null;
            return (
              <div className="grid gap-4 md:grid-cols-2">
                {screenshotSrc && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
                      <ImageIcon className="h-3 w-3" />
                      Screenshot
                    </p>
                    <div onClick={(e) => e.stopPropagation()}>
                      <BugScreenshotZoomDialog src={screenshotSrc} />
                    </div>
                  </div>
                )}
                {clipRange && videoUrl && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1.5 flex items-center gap-1">
                      <Play className="h-3 w-3" weight="fill" />
                      Recording
                    </p>
                    <BugRecordingClip
                      videoUrl={videoUrl}
                      startSec={clipRange.startSec}
                      endSec={clipRange.endSec}
                      posterSrc={screenshotSrc ?? undefined}
                      bugName={displayName}
                    />
                  </div>
                )}
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
              {projectId && dbBug?.id && isOpen && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      markForFix();
                    }}
                  >
                    Mark for fix
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

          {SHOW_RUN_DEBUG && (
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
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// LLM Calls tab
// ============================================================

function LLMTab({
  runId,
  llmCalls,
  totalCost,
  runStatus,
  activityFeed,
}: {
  runId: string;
  llmCalls: LLMCallRecord[];
  totalCost: number;
  runStatus: string;
  activityFeed: ActivityEntry[];
}) {
  const [agentFilter, setAgentFilter] = React.useState<UIAgentGroup | "all">("all");
  const [selectedCall, setSelectedCall] = React.useState<LLMCallRecord | null>(null);

  const totalInput  = llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutput = llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalMs     = llmCalls.reduce((s, c) => s + c.durationMs, 0);
  const visionCalls = llmCalls.filter((c) => c.hasVision).length;
  const scanCalls   = llmCalls.filter((c) => c.role === "dom-scan").length;

  const filteredCalls = agentFilter === "all"
    ? llmCalls
    : llmCalls.filter((c) => uiAgentGroup(c.agent) === agentFilter);
  const selectedIndex = selectedCall
    ? filteredCalls.findIndex((c) => String(c.seq) === String(selectedCall.seq))
    : -1;

  const agentCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: llmCalls.length };
    for (const a of UI_AGENT_GROUP_ORDER) {
      counts[a] = llmCalls.filter((c) => uiAgentGroup(c.agent) === a).length;
    }
    return counts;
  }, [llmCalls]);

  const agentCosts = React.useMemo(() => {
    const cost: Record<string, number> = {};
    for (const a of UI_AGENT_GROUP_ORDER) {
      cost[a] = llmCalls.filter((c) => uiAgentGroup(c.agent) === a).reduce((s, c) => s + c.costUsd, 0);
    }
    return cost;
  }, [llmCalls]);

  const agentsWithCalls = UI_AGENT_GROUP_ORDER.filter((a) => (agentCounts[a] ?? 0) > 0);
  const latestActivityText = React.useMemo(() => {
    for (let i = activityFeed.length - 1; i >= 0; i -= 1) {
      const item = activityFeed[i];
      if (item.type === "activity" && item.activity?.text) return item.activity.text;
    }
    return null;
  }, [activityFeed]);

  return (
    <div className="px-6 py-5 max-w-5xl w-full mx-auto space-y-4 animate-fade-in">

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total Cost" value={formatCost(totalCost)} mono variant="primary" />
        <MetricCard label="Calls" value={String(llmCalls.length)} />
        <MetricCard label="Tokens In" value={totalInput.toLocaleString()} mono />
        <MetricCard label="Tokens Out" value={totalOutput.toLocaleString()} mono />
      </div>
      {runStatus === "running" && latestActivityText && (
        <Card className="border-border/60 bg-muted/20">
          <CardContent className="px-3 py-2 flex items-center gap-2">
            <Spinner className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
            <p className="text-[11px] text-foreground/90 truncate">{latestActivityText}</p>
          </CardContent>
        </Card>
      )}

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
              const groupDisplayAgent: LLMAgentType =
                a === "navigator" ? "navigator" : a === "review" ? "review" : "memory_curator";
              const { label, Icon, color } = llmAgentDisplay(groupDisplayAgent);
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
              <LLMCallRow
                key={call.seq}
                call={call}
                onSelect={setSelectedCall}
                isSelected={
                  selectedCall !== null && String(selectedCall.seq) === String(call.seq)
                }
              />
            ))}
          </div>
          <LLMCallDetailSheet
            runId={runId}
            calls={filteredCalls}
            selectedCall={selectedCall}
            selectedIndex={selectedIndex}
            onSelect={setSelectedCall}
            onOpenChange={(open) => {
              if (!open) setSelectedCall(null);
            }}
          />
        </>
      )}
    </div>
  );
}

function LLMCallRow({
  call,
  onSelect,
  isSelected,
}: {
  call: LLMCallRecord;
  onSelect: (call: LLMCallRecord) => void;
  isSelected: boolean;
}) {
  const isScan = call.role === "dom-scan";
  const agent  = call.agent ?? "navigator";
  const agentInfo = llmAgentDisplay(agent);

  return (
    <Card className={cn(
      "overflow-visible transition-colors",
      agent !== "navigator" && "border-l-2 border-l-border/60",
      isSelected && "ring-1 ring-border",
    )}>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
        onClick={() => onSelect(call)}
      >
        {/* Seq */}
        <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums w-5 text-right flex-shrink-0">
          {call.seq}
        </span>

        {/* Agent badge */}
        <span
          className={cn(
            "text-[10px] font-medium flex items-center gap-0.5 flex-shrink-0 rounded-md border px-1.5 py-0.5",
            agentInfo.badgeClass,
          )}
        >
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
        <span className="text-[11px] font-mono tabular-nums text-foreground/75 w-14 text-right flex-shrink-0">
          {call.inputTokens.toLocaleString()}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-foreground/75 w-14 text-right flex-shrink-0">
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
        <CaretRight className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
      </button>
    </Card>
  );
}

function LLMCallDetailSheet({
  runId,
  calls,
  selectedCall,
  selectedIndex,
  onSelect,
  onOpenChange,
}: {
  runId: string;
  calls: LLMCallRecord[];
  selectedCall: LLMCallRecord | null;
  selectedIndex: number;
  onSelect: (call: LLMCallRecord) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [wrapResponse, setWrapResponse] = React.useState(true);
  const [activeTab, setActiveTab] = React.useState("conversation");
  const call = selectedCall;
  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex >= 0 && selectedIndex < calls.length - 1;
  const agentInfo = llmAgentDisplay(call?.agent ?? "navigator");
  const allMessages = call?.requestMessages ?? [];
  const systemMessages = allMessages.filter((m) => m.role.toLowerCase() === "system");
  const conversationMessages = allMessages.filter((m) => m.role.toLowerCase() !== "system");
  const imageCount = call
    ? Math.max(call.imagePaths?.length ?? 0, call.imageBase64s?.length ?? 0, call.imagePath || call.imageBase64 ? 1 : 0)
    : 0;

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // no-op for unsupported clipboard environments
    }
  }

  return (
    <Sheet open={!!call} onOpenChange={onOpenChange}>
      <SheetContent className="z-[120] !translate-x-0 !opacity-100 right-0 flex flex-col p-0 gap-0 w-full sm:max-w-3xl">
        {!call ? null : (
          <>
            <SheetHeader className="sticky top-0 z-10 border-b border-border bg-popover p-4 space-y-3">
              <SheetTitle className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-muted-foreground">#{call.seq}</p>
                  <p className="text-[13px] font-medium text-foreground truncate">
                    {agentInfo.label} · {call.model}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={!canPrev}
                    onClick={() => canPrev && onSelect(calls[selectedIndex - 1])}
                  >
                    Prev
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={!canNext}
                    onClick={() => canNext && onSelect(calls[selectedIndex + 1])}
                  >
                    Next
                  </Button>
                </div>
              </SheetTitle>
              <SheetDescription className="sr-only">
                Detailed request, response, and metadata for selected LLM call.
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] h-5">
                  <agentInfo.Icon className="h-3 w-3 mr-1" />
                  {agentInfo.label}
                </Badge>
                <Badge variant={call.hasVision ? "secondary" : "outline"} className="text-[10px] h-5">
                  {call.hasVision ? "vision" : "text"}
                </Badge>
                {call.attempt > 1 && (
                  <Badge variant="neutral" className="text-[10px] h-5">
                    retry x{call.attempt}
                  </Badge>
                )}
                {call.role === "dom-scan" && (
                  <Badge variant="neutral" className="text-[10px] h-5">dom-scan</Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
                <span>In <span className="font-mono text-foreground/80">{call.inputTokens.toLocaleString()}</span></span>
                <span>Out <span className="font-mono text-foreground/80">{call.outputTokens.toLocaleString()}</span></span>
                <span>Cost <span className="font-mono text-foreground/80">{formatCost(call.costUsd)}</span></span>
                <span>Time <span className="font-mono text-foreground/80">{formatMs(call.durationMs)}</span></span>
              </div>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="system">System ({systemMessages.length})</TabsTrigger>
                  <TabsTrigger value="conversation">
                    Conversation ({conversationMessages.length || (call.query ? 1 : 0)})
                  </TabsTrigger>
                  {call.agent === "filmstrip" && <TabsTrigger value="filmstrip">Filmstrip ({imageCount})</TabsTrigger>}
                  <TabsTrigger value="response">Response</TabsTrigger>
                  <TabsTrigger value="raw">Raw JSON</TabsTrigger>
                </TabsList>
              </Tabs>
            </SheetHeader>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 flex flex-col">
              <TabsContent value="system" className="mt-0 p-4 min-h-0 overflow-y-auto space-y-3">
                {systemMessages.length > 0 ? (
                  systemMessages.map((m, mi) => (
                    <Card key={`${m.role}-${mi}`} className={cn(m.role === "system" && "border-border/80 bg-muted/15")}>
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <Badge variant="outline" className="text-[10px] h-5 font-mono uppercase">
                            {llmRoleLabel(m.role)}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => void copyText(messageTextContent(m.content))}
                          >
                            Copy
                          </Button>
                        </div>
                        {typeof m.content === "string" ? (
                          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/85 leading-relaxed">
                            {m.content}
                          </pre>
                        ) : (
                          <div className="space-y-2.5">
                            {m.content.map((part, pi) =>
                              part.type === "text" ? (
                                <pre key={pi} className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/85 leading-relaxed">
                                  {part.text}
                                </pre>
                              ) : (
                                <div key={pi} className="space-y-1">
                                  {part.label ? <p className="text-[10px] text-muted-foreground">{part.label}</p> : null}
                                  {(() => {
                                    const src = llmCallImageSrcByIndex(call, runId, part.imageIndex);
                                    return src ? (
                                      <div className="rounded border border-border bg-black overflow-hidden">
                                        <img src={src} alt={`Input image ${part.imageIndex + 1}`} className="w-full max-h-80 object-contain object-top" />
                                      </div>
                                    ) : (
                                      <p className="text-[10px] text-muted-foreground italic">Image {part.imageIndex + 1} not available on disk</p>
                                    );
                                  })()}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-[11px] text-muted-foreground italic">No system prompt captured for this call.</p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="conversation" className="mt-0 p-4 min-h-0 overflow-y-auto space-y-3">
                {conversationMessages.length > 0 ? (
                  conversationMessages.map((m, mi) => (
                    <Card key={`${m.role}-${mi}`}>
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <Badge variant="outline" className="text-[10px] h-5 font-mono uppercase">
                            {llmRoleLabel(m.role)}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => void copyText(messageTextContent(m.content))}
                          >
                            Copy
                          </Button>
                        </div>
                        {typeof m.content === "string" ? (
                          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/85 leading-relaxed">
                            {m.content}
                          </pre>
                        ) : (
                          <div className="space-y-2.5">
                            {m.content.map((part, pi) =>
                              part.type === "text" ? (
                                <pre key={pi} className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/85 leading-relaxed">
                                  {part.text}
                                </pre>
                              ) : (
                                <div key={pi} className="space-y-1">
                                  {part.label ? <p className="text-[10px] text-muted-foreground">{part.label}</p> : null}
                                  {(() => {
                                    const src = llmCallImageSrcByIndex(call, runId, part.imageIndex);
                                    return src ? (
                                      <div className="rounded border border-border bg-black overflow-hidden">
                                        <img src={src} alt={`Input image ${part.imageIndex + 1}`} className="w-full max-h-80 object-contain object-top" />
                                      </div>
                                    ) : (
                                      <p className="text-[10px] text-muted-foreground italic">Image {part.imageIndex + 1} not available on disk</p>
                                    );
                                  })()}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <Card>
                    <CardContent className="p-3 space-y-3">
                      {call.query ? (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/85 leading-relaxed">
                          {call.query}
                        </pre>
                      ) : (
                        <p className="text-[11px] text-muted-foreground italic">No conversation messages stored for this call.</p>
                      )}
                      {imageCount > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {Array.from({ length: imageCount }, (_, i) => {
                            const src = llmCallImageSrcByIndex(call, runId, i);
                            return src ? (
                              <div key={i} className="rounded border border-border bg-black overflow-hidden">
                                <p className="text-[9px] font-mono text-muted-foreground px-2 py-1 border-b border-border/50">Image {i + 1}</p>
                                <img src={src} alt={`Screenshot ${i + 1}`} className="w-full max-h-64 object-contain object-top" />
                              </div>
                            ) : null;
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="filmstrip" className="mt-0 p-4 min-h-0 overflow-y-auto">
                {call.agent === "filmstrip" ? <FilmstripSentToModel call={call} runId={runId} /> : null}
              </TabsContent>

              <TabsContent value="response" className="mt-0 p-4 min-h-0 overflow-y-auto space-y-2">
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setWrapResponse((v) => !v)}
                  >
                    {wrapResponse ? "No wrap" : "Wrap"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void copyText(call.response ?? "")}
                  >
                    Copy
                  </Button>
                </div>
                <div className="rounded-md border border-border bg-muted/20 overflow-auto max-h-[70vh]">
                  <pre
                    className={cn(
                      "text-[11px] font-mono p-3 text-foreground/85 leading-relaxed",
                      wrapResponse ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                    )}
                  >
                    {call.response || "No response stored for this call."}
                  </pre>
                </div>
              </TabsContent>

              <TabsContent value="raw" className="mt-0 p-4 min-h-0 overflow-y-auto space-y-2">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void copyText(JSON.stringify(call, null, 2))}
                  >
                    Copy
                  </Button>
                </div>
                <div className="rounded-md border border-border bg-muted/20 overflow-auto max-h-[70vh]">
                  <pre className="text-[11px] font-mono whitespace-pre p-3 text-foreground/85 leading-relaxed">
                    {JSON.stringify(call, null, 2)}
                  </pre>
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
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
