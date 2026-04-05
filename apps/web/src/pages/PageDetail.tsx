import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Play,
  Trash,
  Brain,
  Clock,
  Repeat,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/status-dot";
import { cn } from "@/lib/utils";
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

const HEALTH_VARIANT: Record<string, "success" | "warning" | "neutral" | "destructive"> = {
  clean: "success",
  issues: "warning",
  stale: "warning",
  untested: "neutral",
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
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-border bg-card/50">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="px-6 py-5 max-w-4xl mx-auto w-full space-y-4 animate-fade-in">
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
      <div className="flex flex-col h-full">
        <div className="px-6 py-6 max-w-4xl mx-auto space-y-4">
          <button
            onClick={() => navigate("/pages")}
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Pages
          </button>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-foreground">
            {error || "Page not found"}
          </div>
        </div>
      </div>
    );
  }

  const { page, recentRuns } = data;
  const hasRegressionPlan = page.regression_plan && page.regression_plan.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border bg-card/50 px-6 py-3">
        <div className="max-w-4xl mx-auto space-y-2">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <button
              onClick={() => navigate("/pages")}
              className="hover:text-foreground transition-colors flex items-center gap-1"
            >
              <ArrowLeft className="h-3 w-3" />
              Pages
            </button>
            <span>/</span>
            <span className="font-mono text-foreground truncate">{page.normalized_route}</span>
          </div>

          {/* Title row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <StatusDot status={page.health_status} />
              <h1 className="font-mono text-[14px] font-semibold text-foreground truncate">
                {page.normalized_route}
              </h1>
              <Badge variant={HEALTH_VARIANT[page.health_status] ?? "neutral"} className="capitalize">
                {page.health_status}
              </Badge>
              {page.issues_count > 0 && (
                <Badge variant="warning">
                  {page.issues_count} issue{page.issues_count !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {confirmReset ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5">
                  <span className="text-[11px] text-destructive">Delete all page data?</span>
                  <Button size="sm" variant="destructive" onClick={handleReset} loading={resetting} className="h-7 text-[11px]">
                    Yes, reset
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)} className="h-7 text-[11px]">
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmReset(true)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleRun}
                disabled={!page.enabled || !defaultEnvId}
                loading={running}
              >
                {!running && <Play className="h-3.5 w-3.5" />}
                Run this page
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Tabbed content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-4xl mx-auto animate-fade-in">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview">
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <table className="w-full text-[13px]">
                    <tbody className="divide-y divide-border">
                      <tr>
                        <td className="px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide w-32">Route</td>
                        <td className="px-4 py-2 font-mono text-foreground">{page.normalized_route}</td>
                      </tr>
                      {page.title && (
                        <tr>
                          <td className="px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Title</td>
                          <td className="px-4 py-2 text-foreground">{page.title}</td>
                        </tr>
                      )}
                      <tr>
                        <td className="px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Health</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <StatusDot status={page.health_status} />
                            <span className="text-foreground capitalize">{page.health_status}</span>
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Last inspected</td>
                        <td className="px-4 py-2 font-mono text-muted-foreground">
                          {page.last_inspected_at ? relativeTime(page.last_inspected_at) : "Never"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Regression plan */}
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
            </TabsContent>

            {/* Memory */}
            <TabsContent value="memory">
              {memory.length === 0 ? (
                <div className="text-center py-12 text-[13px] text-muted-foreground">
                  No memory entries for this page yet.
                </div>
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
                <div className="text-center py-12 text-[13px] text-muted-foreground">
                  No runs for this page yet.
                </div>
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
