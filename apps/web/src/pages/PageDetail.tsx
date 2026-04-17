import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Play,
  Trash,
  Brain,
  Repeat,
  Stack,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { relativeTime, duration, statusVariant, runListLabel } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import { fetchPageDetail, fetchPageMemory, fetchEnvironments, runDestination, resetPageData } from "@/projectApi";
import type { MemoryEntry } from "@/projectApi";
import { RegressionPlanView, type RegressionStep } from "@/pages/TestsPlans";

type PageData = {
  page: {
    id: string;
    normalized_route: string;
    title: string;
    health_status: string;
    issues_count: number;
    enabled: boolean;
    regression_plan?: any[] | null;
    plan_status?: "none" | "ready" | "stale" | null;
    plan_success_count?: number;
    last_inspected_at: string | null;
    last_crawled_at?: string;
  };
  recentRuns: Array<{
    id: string;
    status: string;
    summary?: string;
    display_name?: string | null;
    source_label?: string | null;
    started_at?: string;
    completed_at?: string | null;
    trigger_ref?: string;
  }>;
};

export function PageDetail() {
  const { destinationId } = useParams<{ destinationId: string }>();
  const navigate = useNavigate();
  const { currentProjectId } = useProject();
  const [data, setData] = React.useState<PageData | null>(null);
  const [memory, setMemory] = React.useState<MemoryEntry[]>([]);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!currentProjectId || !destinationId) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, memoryRes, envsRes] = await Promise.all([
        fetchPageDetail(currentProjectId, destinationId),
        fetchPageMemory(currentProjectId, destinationId),
        fetchEnvironments(currentProjectId),
      ]);
      setData(detailRes as PageData);
      setMemory((memoryRes as { entries: MemoryEntry[] }).entries || []);
      setEnvironments((envsRes as { environments: any[] }).environments || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load page");
      setData(null);
      setMemory([]);
      setEnvironments([]);
    }
    setLoading(false);
  }, [currentProjectId, destinationId]);

  React.useEffect(() => { load(); }, [load]);

  const defaultEnv = environments.find((e: any) => e.is_default) || environments[0];
  const defaultEnvId = defaultEnv?.id ?? null;

  async function handleRun() {
    if (!currentProjectId || !destinationId || !defaultEnvId) return;
    setRunning(true);
    try {
      await runDestination(currentProjectId, defaultEnvId, destinationId);
      navigate("/runs");
    } catch {}
    setRunning(false);
  }

  async function handleReset() {
    if (!currentProjectId || !destinationId) return;
    setResetting(true);
    try {
      await resetPageData(currentProjectId, destinationId);
      setConfirmReset(false);
      await load();
    } catch {}
    setResetting(false);
  }

  if (loading) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-border bg-surface-2/80 backdrop-blur-sm flex-shrink-0">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-48" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-8" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="px-6 py-5 space-y-4 animate-fade-in">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-border bg-surface-2/80 backdrop-blur-sm flex-shrink-0">
          <button
            onClick={() => navigate("/pages")}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Pages
          </button>
        </div>
        <div className="px-6 py-5">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-foreground">
            {error || "Page not found"}
          </div>
        </div>
      </div>
    );
  }

  const { page, recentRuns } = data;
  const hasRegressionPlan = page.regression_plan && page.regression_plan.length > 0;
  const routeRaw = (page.normalized_route ?? "/").trim() || "/";

  const statusHint =
    page.issues_count > 0
      ? `${page.issues_count} issue${page.issues_count !== 1 ? "s" : ""}`
      : page.health_status !== "clean"
        ? page.health_status.replace(/_/g, " ")
        : null;

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 h-12 border-b border-border bg-surface-2/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/pages")}
            className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Pages
          </button>
          <span className="select-none text-muted-foreground/35 text-[14px]" aria-hidden>/</span>
          <StatusDot status={page.health_status} />
          <h1 className="min-w-0 truncate font-display font-semibold text-[14px] tracking-tight text-foreground font-mono" title={routeRaw}>
            {routeRaw}
          </h1>
          {statusHint && (
            <span className="shrink-0 capitalize text-[11px] text-muted-foreground/70">{statusHint}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!confirmReset ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmReset(true)}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              aria-label="Reset page data"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={handleRun}
            disabled={!page.enabled || !defaultEnvId}
            loading={running}
            className="h-8 gap-1.5 text-[12px]"
          >
            {!running && <Play className="h-3.5 w-3.5" />}
            Run this page
          </Button>
        </div>
      </div>

      {/* Confirm reset banner */}
      {confirmReset && (
        <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b border-border bg-destructive/5">
          <span className="text-[11px] text-destructive/90 flex-1">Delete all runs and data for this page?</span>
          <Button size="sm" variant="destructive" onClick={handleReset} loading={resetting} className="h-7 text-[11px]">
            Yes, reset
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)} className="h-7 text-[11px]">
            Cancel
          </Button>
        </div>
      )}

      {/* Tabbed content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="animate-fade-in">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="runs">
                Runs
                {recentRuns.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
                    {recentRuns.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Main — route + regression plan */}
                <div className="lg:col-span-2 space-y-4">
                  <div className="rounded-lg border border-border bg-card p-4 space-y-1">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Route</p>
                    <p className="font-mono text-[14px] text-foreground break-all">{page.normalized_route}</p>
                    {page.title && (
                      <p className="text-[12px] text-muted-foreground mt-1">{page.title}</p>
                    )}
                  </div>

                  {hasRegressionPlan && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[13px] font-medium text-foreground">Regression script</span>
                        {page.plan_status === "ready" && <Badge variant="success">Active</Badge>}
                        {page.plan_status === "stale" && <Badge variant="warning">Stale</Badge>}
                        {(page.plan_success_count ?? 0) > 0 && (
                          <span className="text-[11px] text-muted-foreground/50 ml-auto font-mono">
                            {page.plan_success_count} successful replay{page.plan_success_count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <RegressionPlanView steps={page.regression_plan as RegressionStep[]} />
                    </div>
                  )}
                </div>

                {/* Sidebar — metadata */}
                <div className="space-y-px rounded-lg border border-border bg-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-border">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Health</p>
                    <div className="flex items-center gap-2">
                      <StatusDot status={page.health_status} />
                      <span className="text-[13px] text-foreground capitalize">{page.health_status.replace(/_/g, " ")}</span>
                    </div>
                  </div>
                  <div className="px-4 py-3 border-b border-border">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Issues</p>
                    <p className="text-[13px] text-foreground">
                      {page.issues_count > 0 ? page.issues_count : (
                        <span className="text-muted-foreground/50">None</span>
                      )}
                    </p>
                  </div>
                  <div className="px-4 py-3 border-b border-border">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Script</p>
                    <div>
                      {page.plan_status === "ready" && <Badge variant="success">Ready</Badge>}
                      {page.plan_status === "stale" && <Badge variant="warning">Stale</Badge>}
                      {(!page.plan_status || page.plan_status === "none") && (
                        <span className="text-[13px] text-muted-foreground/50">None yet</span>
                      )}
                    </div>
                  </div>
                  <div className="px-4 py-3 border-b border-border">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Last inspected</p>
                    <p className="text-[13px] font-mono text-muted-foreground">
                      {page.last_inspected_at ? relativeTime(page.last_inspected_at) : (
                        <span className="text-muted-foreground/50">Never</span>
                      )}
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-0.5">Enabled</p>
                    <p className="text-[13px] text-foreground">{page.enabled ? "Yes" : "No"}</p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Memory */}
            <TabsContent value="memory">
              {memory.length === 0 ? (
                <EmptyState
                  icon={<Brain className="h-5 w-5" />}
                  title="No memory entries yet"
                  description="Memory is built up as the agent inspects this page over time."
                  className="py-16"
                />
              ) : (
                <div className="space-y-1.5">
                  {memory.map((e) => (
                    <div key={e.id} className="rounded-lg border border-border bg-card px-3 py-2 flex items-start gap-2">
                      <Brain className="h-3.5 w-3.5 text-muted-foreground/50 mt-0.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <span className="text-[13px] font-medium text-foreground">{e.type}</span>
                        {e.summary && (
                          <p className="text-[12px] text-muted-foreground mt-0.5">{e.summary}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Runs */}
            <TabsContent value="runs">
              {recentRuns.length === 0 ? (
                <EmptyState
                  icon={<Play className="h-5 w-5" />}
                  title="No runs yet"
                  description="Hit Run to execute this page and see results here."
                  className="py-16"
                />
              ) : (
                <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
                  {recentRuns.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => navigate(`/runs/${run.id}`)}
                      className="flex items-center gap-3 px-4 py-2.5 w-full text-left hover:bg-accent/40 transition-colors"
                    >
                      <StatusDot status={run.status} />
                      <Badge variant={statusVariant(run.status)} className="capitalize text-[11px]">
                        {run.status}
                      </Badge>
                      <span className="text-[13px] text-muted-foreground truncate flex-1">
                        {runListLabel(run)}
                      </span>
                      {run.started_at && (
                        <span className="text-[11px] font-mono text-muted-foreground/50 flex-shrink-0">
                          {relativeTime(run.started_at)}
                        </span>
                      )}
                      {run.started_at && (
                        <span className="text-[11px] font-mono text-muted-foreground/40 flex-shrink-0">
                          {duration(run.started_at, run.completed_at ?? undefined)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
