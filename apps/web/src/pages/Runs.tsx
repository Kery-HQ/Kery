import React from "react";
import { useNavigate } from "react-router-dom";
import { Pulse, ArrowsClockwise, CaretDown, CaretRight } from "@phosphor-icons/react";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { statusVariant, duration, relativeTime, formatRunCost, runListLabel } from "@/lib/formatters";
import { runScreenshotFileUrl } from "@/lib/apiAssets";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import { fetchProjectRuns, fetchRun, stopRun } from "@/projectApi";

const STATUS_FILTERS = ["all", "running", "queued", "passed", "failed", "stopped"] as const;
const PAGE_SIZE = 25;

type ActiveRunTile = {
  id: string;
  status: "running" | "queued";
  started_at?: string;
  source_label?: string | null;
  display_name?: string | null;
  livePreviewUrl?: string | null;
  liveSteps?: number;
  livePlanItems?: number;
};

export const Runs: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();

  const [runs, setRuns] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<(typeof STATUS_FILTERS)[number]>("all");
  const [activeRuns, setActiveRuns] = React.useState<ActiveRunTile[]>([]);
  const activeRunsRef = React.useRef<ActiveRunTile[]>([]);
  const [activeLoading, setActiveLoading] = React.useState(false);
  const activeLoadedRef = React.useRef(false);
  const [liveExpanded, setLiveExpanded] = React.useState(false);
  const [stoppingRunId, setStoppingRunId] = React.useState<string | null>(null);

  React.useEffect(() => {
    activeRunsRef.current = activeRuns;
  }, [activeRuns]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = search.length > 0 || status !== "all";

  const load = React.useCallback(async () => {
    if (!currentProjectId) return;
    setLoading((prev) => runs.length === 0 ? true : prev);
    const res = await fetchProjectRuns(currentProjectId, {
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      status: status === "all" ? undefined : status,
    }).catch(() => ({ runs: [], total: 0 }));
    setRuns(res.runs ?? []);
    setTotal(Number(res.total ?? 0));
    setLoading(false);
  }, [currentProjectId, page, search, status, runs.length]);

  React.useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  React.useEffect(() => {
    setPage(1);
  }, [currentProjectId, status]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    if (!currentProjectId) {
      activeLoadedRef.current = false;
      setActiveRuns([]);
      return;
    }
    activeLoadedRef.current = false;
    let cancelled = false;

    const loadActiveRuns = async () => {
      if (cancelled) return;
      if (!activeLoadedRef.current) setActiveLoading(true);
      try {
        const [runningRes, queuedRes] = await Promise.all([
          fetchProjectRuns(currentProjectId, { page: 1, pageSize: 100, status: "running" }),
          fetchProjectRuns(currentProjectId, { page: 1, pageSize: 100, status: "queued" }),
        ]);
        if (cancelled) return;
        const running = (runningRes.runs ?? []) as ActiveRunTile[];
        const queued = (queuedRes.runs ?? []) as ActiveRunTile[];
        const prevById = new Map(activeRunsRef.current.map((r) => [r.id, r]));
        const runningWithPreview = await Promise.all(
          running.map(async (run) => {
            try {
              const detail = await fetchRun(run.id);
              const live = (detail?.run?.live_snapshot?.livePreview ??
                null) as { filename?: string; updatedAt?: number } | null;
              const liveSteps = Array.isArray(detail?.run?.steps_json) ? detail.run.steps_json.length : 0;
              const livePlanItems = Array.isArray(detail?.run?.live_snapshot?.agentPlan?.items)
                ? detail.run.live_snapshot.agentPlan.items.length
                : 0;
              const filename = live?.filename;
              const updatedAt = live?.updatedAt;
              const base = filename ? runScreenshotFileUrl(run.id, filename) : null;
              return {
                ...run,
                status: "running" as const,
                livePreviewUrl: base && updatedAt ? `${base}?t=${updatedAt}` : base,
                liveSteps,
                livePlanItems,
              };
            } catch {
              const prev = prevById.get(run.id);
              return {
                ...run,
                status: "running" as const,
                livePreviewUrl: prev?.livePreviewUrl ?? null,
                liveSteps: prev?.liveSteps ?? 0,
                livePlanItems: prev?.livePlanItems ?? 0,
              };
            }
          }),
        );
        setActiveRuns([
          ...runningWithPreview,
          ...queued.map((q) => ({ ...q, status: "queued" as const })),
        ]);
        activeLoadedRef.current = true;
      } catch {
        // Keep previous active run state if transient polling fails.
      } finally {
        if (!cancelled) setActiveLoading(false);
      }
    };

    void loadActiveRuns();
    const interval = window.setInterval(loadActiveRuns, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentProjectId]);

  // Auto-refresh every 5s while any run is running or queued
  React.useEffect(() => {
    const hasActive = runs.some((r) => r.status === "running" || r.status === "queued");
    if (!hasActive) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [runs, load]);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Pulse className="h-4 w-4" />} title="Runs">
        {!loading && runs.length > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground">{total} runs</span>
        )}
        <Button variant="outline" size="sm" onClick={load} className="h-7 gap-1.5 text-[12px]">
          <ArrowsClockwise className="h-3 w-3" />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-6 py-6 animate-fade-in">
        {!currentProjectId ? (
          <EmptyState
            icon={<Pulse className="h-6 w-6" />}
            title="No project selected"
            description="Select a project to view runs."
          />
        ) : loading ? (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                    <Skeleton className="h-2 w-2 rounded-full" />
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-5 w-16 rounded-md" />
                    <Skeleton className="h-3 flex-1" />
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-10" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {(activeLoading || activeRuns.length > 0) && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">
                    Live runs
                  </p>
                  <div className="flex items-center gap-3">
                    {activeRuns.some((r) => r.status === "running") && (
                      <button
                        type="button"
                        onClick={() => setLiveExpanded((v) => !v)}
                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {liveExpanded ? (
                          <CaretDown className="h-3.5 w-3.5" />
                        ) : (
                          <CaretRight className="h-3.5 w-3.5" />
                        )}
                        {liveExpanded ? "Collapse running tiles" : "Expand running tiles"}
                      </button>
                    )}
                    <span className="text-[10px] font-mono text-muted-foreground/50">
                      updates every 1s
                    </span>
                  </div>
                </div>

                {activeLoading && activeRuns.length === 0 ? (
                  <div className="text-[12px] text-muted-foreground">Loading active runs...</div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="warning" className="text-[10px]">
                        {activeRuns.filter((r) => r.status === "queued").length} queued
                      </Badge>
                      {activeRuns
                        .filter((r) => r.status === "queued")
                        .map((run) => (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => navigate(`/runs/${run.id}`)}
                            className="h-6 px-2 rounded-md border border-border bg-muted/30 hover:bg-muted/50 text-[10px] font-mono text-muted-foreground/80"
                            title={runListLabel(run as any)}
                          >
                            queued · {run.id.slice(0, 6)}
                          </button>
                        ))}
                    </div>

                    {activeRuns.some((r) => r.status === "running") && (
                      <>
                        <div className={cn(
                          "grid gap-2",
                          liveExpanded
                            ? "grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                            : "grid-cols-2 lg:grid-cols-4",
                        )}>
                        {activeRuns
                          .filter((r) => r.status === "running")
                          .slice(0, liveExpanded ? undefined : 4)
                          .map((run) => (
                            <button
                              key={run.id}
                              type="button"
                              onClick={() => navigate(`/runs/${run.id}`)}
                              className="rounded-lg border border-border bg-card hover:bg-accent/20 transition-colors overflow-hidden text-left"
                            >
                              <div className="aspect-[16/9] bg-black relative">
                                {run.livePreviewUrl ? (
                                  <img
                                    src={run.livePreviewUrl}
                                    alt="Live preview"
                                    className="w-full h-full object-contain object-top"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground bg-muted/30">
                                    Preparing live preview...
                                  </div>
                                )}
                                <Badge variant="running" className="absolute top-1.5 left-1.5 text-[10px]">
                                  running
                                </Badge>
                              </div>
                              <div className="px-2 py-1.5">
                                <p className="text-[11px] text-foreground truncate">{runListLabel(run as any)}</p>
                                <div className="mt-1 flex items-center justify-between gap-2">
                                  <p className="text-[10px] font-mono text-muted-foreground/60 truncate">
                                    {run.started_at ? relativeTime(run.started_at) : run.id.slice(0, 8)}
                                  </p>
                                  <div className="flex items-center gap-1">
                                    {(run.livePlanItems ?? 0) > 0 && (
                                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                        plan {(run.livePlanItems ?? 0)}
                                      </Badge>
                                    )}
                                    {(run.liveSteps ?? 0) > 0 && (
                                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                        steps {(run.liveSteps ?? 0)}
                                      </Badge>
                                    )}
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    className="h-5 px-1.5 text-[9px]"
                                    disabled={stoppingRunId === run.id}
                                    onClick={async (e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setStoppingRunId(run.id);
                                      try {
                                        await stopRun(run.id);
                                        await load();
                                      } catch {
                                        // no-op
                                      } finally {
                                        setStoppingRunId(null);
                                      }
                                    }}
                                  >
                                    {stoppingRunId === run.id ? "..." : "Stop"}
                                  </Button>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by run id or label"
                className="h-8 max-w-sm"
              />
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}
                className="h-8 w-40"
              >
                {STATUS_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {value === "all" ? "All statuses" : value}
                  </option>
                ))}
              </Select>
            </div>
            <Card>
              {total === 0 ? (
                <CardContent className="py-12">
                  {hasFilters ? (
                    <EmptyState
                      icon={<Pulse className="h-6 w-6" />}
                      title="No runs match your filters"
                      description="Try a different search or status."
                    />
                  ) : (
                    <EmptyState
                      icon={<Pulse className="h-6 w-6" />}
                      title="No runs yet"
                      description="Trigger a run from the Flows page to get started."
                      action={{ label: "Go to Flows", onClick: () => navigate("/tests") }}
                    />
                  )}
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {runs.map((r: any) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => navigate(`/runs/${r.id}`)}
                        className="group w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-accent/40 transition-colors"
                      >
                        <StatusDot status={r.status} />
                        <span className="font-mono text-[11px] text-muted-foreground w-[5.5rem] flex-shrink-0 truncate">
                          {r.id.slice(0, 8)}
                        </span>
                        <span className="flex-1 text-[13px] text-foreground truncate min-w-0">
                          {runListLabel(r)}
                        </span>
                        <Badge variant={statusVariant(r.status)} dot className="flex-shrink-0 text-[10px]">
                          {r.status}
                        </Badge>
                        <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 w-[4.25rem] text-right tabular-nums">
                          {formatRunCost(r)}
                        </span>
                        <span className="text-[11px] font-mono text-muted-foreground/60 flex-shrink-0 w-14 text-right">
                          {duration(r.started_at, r.completed_at)}
                        </span>
                        <span className="text-[11px] font-mono text-muted-foreground/40 flex-shrink-0 w-14 text-right">
                          {relativeTime(r.completed_at ?? r.started_at)}
                        </span>
                      </button>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
            {total > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-mono">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
