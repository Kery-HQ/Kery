import React from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Stack,
  ArrowsClockwise,
  MagnifyingGlass,
  Play,
  Trash,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { relativeTime, formatCrawlLlmCostLine, duration } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchPages,
  fetchEnvironments,
  triggerScan,
  fetchScanStatus,
  fetchCrawlRuns,
  togglePage,
  runDestination,
  deletePage,
} from "@/projectApi";
import { ScanBanner, type ScanBannerRun } from "@/components/scan-banner";

type Page = {
  id: string;
  route: string;
  title: string;
  health: "clean" | "issues" | "stale" | "untested";
  issues: number;
  enabled: boolean;
  plan_status?: "none" | "ready" | "stale" | null;
  plan_success_count?: number;
};

type Coverage = {
  total: number;
  tested: number;
  clean: number;
  withIssues: number;
  stale: number;
  untested: number;
};

type CrawlRunRow = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  pages_visited: number | null;
  cost_usd: number | null;
  llm_cost_breakdown_json: { linkFilterUsd?: number; suggestedFlowsUsd?: number } | null;
  crawl_metadata_json?: LastScanMeta | null;
};

type LastScanMeta = {
  phase?: string;
  durationMs?: number;
  baseUrl?: string;
  limits?: Record<string, unknown>;
  live?: {
    queueDepth: number;
    currentUrl: string | null;
    currentRoute: string | null;
  };
  stats?: { pagesVisited?: number; nodesFound?: number; llmCallCount?: number; suggestedFlowsCount?: number };
  inProgress?: boolean;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  diagnostics?: {
    bfsPagesDiscovered: number;
    afterShallowTrim: number;
    afterRouteFilter: number;
    hints: string[];
  };
};

type LastScan = CrawlRunRow;

const HEALTH_FILTERS = ["all", "clean", "issues", "stale", "untested"] as const;
type HealthFilter = (typeof HEALTH_FILTERS)[number];

const HEALTH_LABEL: Record<string, string> = {
  all: "All",
  clean: "Clean",
  issues: "Issues",
  stale: "Stale",
  untested: "Untested",
};

/** After this, the scan button stays clickable and sends `force` to abort a stuck server-side `running` row. */
const SCAN_FORCE_REPLACE_AFTER_MS = 2 * 60 * 1000;


function formatScanLogLine(meta: LastScanMeta): string {
  const parts: string[] = [];
  if (meta.startedAt) parts.push(`started: ${new Date(meta.startedAt).toLocaleString()}`);
  if (meta.finishedAt) parts.push(`finished: ${new Date(meta.finishedAt).toLocaleString()}`);
  if (meta.durationMs != null) parts.push(`duration: ${Math.round(meta.durationMs / 1000)}s`);
  if (meta.baseUrl) parts.push(`base_url: ${meta.baseUrl}`);
  if (meta.stats) {
    const s = meta.stats;
    if (s.pagesVisited != null) parts.push(`pages_visited: ${s.pagesVisited}`);
    if (s.nodesFound != null) parts.push(`nodes_found: ${s.nodesFound}`);
    if (s.suggestedFlowsCount != null) parts.push(`suggested_flows: ${s.suggestedFlowsCount}`);
    if (s.llmCallCount != null) parts.push(`llm_calls: ${s.llmCallCount}`);
  }
  if (meta.diagnostics) {
    const d = meta.diagnostics;
    parts.push(`bfs_pages_discovered: ${d.bfsPagesDiscovered}`);
    parts.push(`after_shallow_cap: ${d.afterShallowTrim}`);
    parts.push(`after_route_filter: ${d.afterRouteFilter}`);
    if (d.hints.length > 0) parts.push(`hints:\n${d.hints.map(h => `  - ${h}`).join("\n")}`);
  }
  if (meta.limits && Object.keys(meta.limits).length > 0) {
    parts.push(`limits: ${JSON.stringify(meta.limits)}`);
  }
  if (meta.error) parts.push(`error: ${meta.error}`);
  return parts.join("\n");
}

export function Pages() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const pid = currentProject?.id;

  const [pages, setPages] = React.useState<Page[]>([]);
  const [coverage, setCoverage] = React.useState<Coverage | null>(null);
  const [lastScan, setLastScan] = React.useState<LastScan | null>(null);
  const [crawlRuns, setCrawlRuns] = React.useState<CrawlRunRow[]>([]);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [scanActive, setScanActive] = React.useState(false);
  const [liveScan, setLiveScan] = React.useState<LastScan | null>(null);
  const scanExpectUntilRef = React.useRef<number | null>(null);
  const [scanSessionStartedAt, setScanSessionStartedAt] = React.useState<number | null>(null);
  const [scanUiTick, setScanUiTick] = React.useState(0);
  const [rateLimited, setRateLimited] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState<HealthFilter>("all");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [scanLogOpen, setScanLogOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Page | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [runBusyId, setRunBusyId] = React.useState<string | null>(null);
  const [testAllBusy, setTestAllBusy] = React.useState(false);

  const defaultEnv = environments.find((e: { is_default?: boolean }) => e.is_default) || environments[0];
  const defaultEnvId: string | null = selectedEnvId ?? defaultEnv?.id ?? null;

  const loadData = React.useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    try {
      const [pagesRes, envsRes, crawlRes] = await Promise.all([
        fetchPages(pid),
        fetchEnvironments(pid),
        fetchCrawlRuns(pid),
      ]);
      setPages(pagesRes.pages || []);
      setCoverage(pagesRes.coverage || null);
      setLastScan(pagesRes.lastScan || null);
      setCrawlRuns((crawlRes as { runs?: CrawlRunRow[] })?.runs || []);
      const loadedEnvs = (envsRes as any).environments || [];
      setEnvironments(loadedEnvs);
      setSelectedEnvId((prev) => prev ?? loadedEnvs.find((e: { is_default?: boolean }) => e.is_default)?.id ?? loadedEnvs[0]?.id ?? null);
      setCrawlRuns((crawlRes as { runs?: CrawlRunRow[] })?.runs || []);
    } catch {}
    setLoading(false);
  }, [pid]);

  React.useEffect(() => { loadData(); }, [loadData]);

  React.useEffect(() => {
    if (scanActive) setScanSessionStartedAt((s) => s ?? Date.now());
    else setScanSessionStartedAt(null);
  }, [scanActive]);

  React.useEffect(() => {
    if (!scanActive) return;
    const iv = window.setInterval(() => setScanUiTick((t) => t + 1), 10_000);
    return () => window.clearInterval(iv);
  }, [scanActive]);

  // Resume polling if page reloads during an active crawl.
  React.useEffect(() => {
    if (!pid) return;
    let cancelled = false;
    (async () => {
      const status = await fetchScanStatus(pid);
      if (cancelled) return;
      const scan = status.scan as LastScan | null;
      if (scan?.status === "running") {
        setScanActive(true);
        setLiveScan(scan);
      }
    })();
    return () => { cancelled = true; };
  }, [pid]);

  // Poll while scan is active; stop when no longer running.
  React.useEffect(() => {
    if (!pid || !scanActive) return;
    let cancelled = false;
    const poll = async () => {
      const status = await fetchScanStatus(pid);
      if (cancelled) return;
      const scan = status.scan as LastScan | null;
      const expectUntil = scanExpectUntilRef.current;

      if (scan?.status === "running") {
        scanExpectUntilRef.current = null;
        setLiveScan(scan);
        return;
      }

      if (expectUntil != null && Date.now() < expectUntil) return;

      scanExpectUntilRef.current = null;
      setScanActive(false);
      setLiveScan(null);
      setScanLogOpen(true);
      loadData();
    };
    const iv = setInterval(poll, 2000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [pid, scanActive, loadData]);

  const canForceReplaceScan = React.useMemo(() => {
    if (!scanActive) return false;
    const t0 = liveScan?.started_at
      ? new Date(liveScan.started_at).getTime()
      : (scanSessionStartedAt ?? Date.now());
    const elapsed = Date.now() - t0 + scanUiTick * 0;
    return elapsed > SCAN_FORCE_REPLACE_AFTER_MS;
  }, [scanActive, liveScan?.started_at, scanSessionStartedAt, scanUiTick]);

  const filteredPages = React.useMemo(() => {
    let result = pages;
    if (healthFilter !== "all") {
      result = result.filter(p => p.health === healthFilter);
    }
    if (filter.trim()) {
      const q = filter.toLowerCase();
      result = result.filter(p =>
        p.route.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
      );
    }
    return result;
  }, [pages, filter, healthFilter]);

  const enabledFilteredPages = React.useMemo(
    () => filteredPages.filter((p) => p.enabled),
    [filteredPages],
  );
  const disabledFilteredPages = React.useMemo(
    () => filteredPages.filter((p) => !p.enabled),
    [filteredPages],
  );

  const handleToggleEnabled = React.useCallback(async (page: Page, enabled: boolean) => {
    if (!pid) return;
    const prev = page.enabled;
    setPages(prevPages => prevPages.map(p => (p.id === page.id ? { ...p, enabled } : p)));
    try {
      await togglePage(pid, page.id, enabled);
    } catch {
      setPages(prevPages => prevPages.map(p => (p.id === page.id ? { ...p, enabled: prev } : p)));
      toast.error("Could not update testing toggle");
    }
  }, [pid]);

  const handleRunPage = React.useCallback(async (page: Page) => {
    if (!pid || !defaultEnvId || !page.enabled) return;
    setRunBusyId(page.id);
    try {
      await runDestination(pid, defaultEnvId, page.id);
      navigate("/runs");
    } catch {
      toast.error("Could not start test run");
    }
    setRunBusyId(null);
  }, [pid, defaultEnvId, navigate]);

  const handleTestAll = React.useCallback(async () => {
    if (!pid || !defaultEnvId) return;
    const targets = pages.filter(p => p.enabled);
    if (targets.length === 0) return;
    setTestAllBusy(true);
    try {
      for (const p of targets) {
        await runDestination(pid, defaultEnvId, p.id);
      }
      navigate("/runs");
    } catch {
      toast.error("Could not queue all tests");
    }
    setTestAllBusy(false);
  }, [pid, defaultEnvId, pages, navigate]);

  const confirmDeletePage = React.useCallback(async () => {
    if (!pid || !deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deletePage(pid, deleteTarget.id);
      setDeleteTarget(null);
      await loadData();
    } catch {
      toast.error("Could not remove page");
    }
    setDeleteBusy(false);
  }, [pid, deleteTarget, loadData]);

  const enabledPageCount = React.useMemo(() => pages.filter(p => p.enabled).length, [pages]);

  async function handleScan(force = false) {
    if (!pid) return;
    setRateLimited(false);
    setScanLogOpen(false);
    try {
      const useForce = force || (scanActive && canForceReplaceScan);
      const res = (await triggerScan(pid, useForce)) as { _status?: number };
      if (res?._status === 429) {
        setRateLimited(true);
        return;
      }
      scanExpectUntilRef.current = Date.now() + 20_000;
      setScanActive(true);
      setLiveScan(null);
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("API 409")) return;
      setScanActive(false);
      scanExpectUntilRef.current = null;
    }
  }

  // The banner run — use live data while scanning, otherwise last scan for summary.
  const bannerRun: ScanBannerRun | null = scanActive
    ? (liveScan ?? {
        status: "running",
        started_at: scanSessionStartedAt
          ? new Date(scanSessionStartedAt).toISOString()
          : new Date().toISOString(),
      })
    : lastScan;

  const totalIssuesFound = pages.reduce((sum, p) => sum + Math.max(0, Number(p.issues || 0)), 0);
  const needsAttentionCount = pages.filter((p) => p.health === "issues" || p.health === "stale").length;
  const issuesPageCount = pages.filter((p) => p.issues > 0).length;

  if (!pid) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Stack className="h-4 w-4" />} title="Routes" />
        <EmptyState
          icon={<Stack className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view routes."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Stack className="h-4 w-4" />} title="Routes">
        <Button
          size="sm"
          variant="outline"
          onClick={() => handleScan()}
          loading={scanActive && !canForceReplaceScan}
        >
          {!(scanActive && !canForceReplaceScan) && <ArrowsClockwise className="h-3.5 w-3.5" />}
          {scanActive
            ? canForceReplaceScan
              ? "Replace stuck scan"
              : "Scanning..."
            : pages.length === 0
              ? "Scan my app"
              : "Scan app"}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-8 py-5 w-full space-y-4 animate-fade-in">
          <div className="grid grid-cols-1 gap-4">
            <aside className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {coverage && coverage.total > 0 && (
                <div className="rounded-lg border border-border/60 bg-card px-3 py-3">
                  <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Signal</p>
                  <div className="mt-2 flex items-center gap-3">
                    <div
                      className="relative h-14 w-14 rounded-full"
                      style={{
                        background: `conic-gradient(
                          rgb(16 185 129) 0 ${(coverage.clean / Math.max(coverage.total, 1)) * 360}deg,
                          rgb(245 158 11) ${(coverage.clean / Math.max(coverage.total, 1)) * 360}deg ${((coverage.clean + coverage.withIssues) / Math.max(coverage.total, 1)) * 360}deg,
                          rgb(251 146 60) ${((coverage.clean + coverage.withIssues) / Math.max(coverage.total, 1)) * 360}deg ${((coverage.clean + coverage.withIssues + coverage.stale) / Math.max(coverage.total, 1)) * 360}deg,
                          rgb(148 163 184 / 0.35) ${((coverage.clean + coverage.withIssues + coverage.stale) / Math.max(coverage.total, 1)) * 360}deg 360deg
                        )`,
                      }}
                    >
                      <div className="absolute inset-2 rounded-full bg-card flex items-center justify-center">
                        <span className="text-[10px] font-semibold tabular-nums text-foreground">
                          {coverage.tested}/{coverage.total}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-0.5 text-[11px] text-muted-foreground">
                      <p>{coverage.clean} clean</p>
                      <p>{coverage.withIssues} issues</p>
                      <p>{coverage.stale} stale</p>
                    </div>
                  </div>
                </div>
              )}
              {/* Issues Found */}
              <div className={cn(
                "rounded-lg border bg-card px-3 py-3",
                totalIssuesFound > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-border/60",
              )}>
                <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Issues Found</p>
                <p className={cn(
                  "mt-2 text-[26px] font-semibold tabular-nums",
                  totalIssuesFound > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
                )}>
                  {pages.length === 0 ? "—" : totalIssuesFound}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {totalIssuesFound === 0
                    ? "No bugs detected"
                    : `Across ${issuesPageCount} route${issuesPageCount !== 1 ? "s" : ""}`}
                </p>
              </div>

              {/* Needs Attention */}
              <div className={cn(
                "rounded-lg border bg-card px-3 py-3",
                needsAttentionCount > 0 ? "border-orange-400/30 bg-orange-400/5" : "border-border/60",
              )}>
                <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Needs Attention</p>
                <p className={cn(
                  "mt-2 text-[26px] font-semibold tabular-nums",
                  needsAttentionCount > 0 ? "text-orange-600 dark:text-orange-400" : "text-foreground",
                )}>
                  {pages.length === 0 ? "—" : needsAttentionCount}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {needsAttentionCount === 0
                    ? "All routes are clean"
                    : "Routes with issues or stale results"}
                </p>
              </div>

              {/* Last Scan */}
              <div className="rounded-lg border border-border/60 bg-card px-3 py-3">
                <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">Last Scan</p>
                <p className="mt-2 text-[26px] font-semibold tabular-nums text-foreground">
                  {lastScan?.pages_visited ?? (pages.length > 0 ? pages.length : "—")}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {lastScan?.completed_at
                    ? `Routes · ${relativeTime(lastScan.completed_at)}`
                    : "Never scanned"}
                </p>
              </div>
            </aside>

            <main className="space-y-3">
              {/* Scan banner — only while running */}
              {scanActive && bannerRun && (
                <ScanBanner run={bannerRun} live={scanActive} />
              )}

              {/* Replace stuck notice */}
              {scanActive && canForceReplaceScan && (
                <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5">
                  <p className="text-[11px] text-muted-foreground">
                    No progress? Use{" "}
                    <span className="font-medium text-foreground">Replace stuck scan</span> in the header
                    to abort this run and start a new one.
                  </p>
                </div>
              )}

              {/* Rate limit notice */}
              {rateLimited && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-center justify-between">
                  <p className="text-[12px] text-muted-foreground">
                    A scan ran in the last hour. Run again anyway?
                  </p>
                  <Button size="sm" variant="outline" onClick={() => handleScan(true)} className="h-7 text-[11px]">
                    Scan anyway
                  </Button>
                </div>
              )}

              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : pages.length === 0 ? (
                <EmptyState
                  icon={<Stack className="h-8 w-8" />}
                  title="No routes discovered yet"
                  description="Click 'Scan my app' to discover app routes, forms, and interactions."
                  action={
                    environments.length === 0
                      ? { label: "Add environment first", onClick: () => navigate("/environments") }
                      : undefined
                  }
                />
              ) : (
                <>
                  <div className="rounded-lg border border-border/60 bg-card p-3 space-y-3">
                    <div className="relative w-full">
                      <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                      <Input
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Filter routes..."
                        className="pl-8"
                      />
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {HEALTH_FILTERS.map(h => (
                        <Button
                          key={h}
                          size="sm"
                          variant="ghost"
                          onClick={() => setHealthFilter(h)}
                          className={cn(
                            "h-7 px-2.5 text-[11px] capitalize",
                            healthFilter === h
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground"
                          )}
                        >
                          {HEALTH_LABEL[h]}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {/* Enabled route tiles */}
                  {enabledFilteredPages.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          Enabled routes ({enabledFilteredPages.length})
                        </p>
                        <div className="flex items-center gap-2">
                          {environments.length > 0 && (
                            <Select
                              value={defaultEnvId ?? ""}
                              onChange={(e) => setSelectedEnvId(e.target.value)}
                              className="w-[170px] h-8 text-[12px]"
                            >
                              {environments.map((env) => (
                                <option key={env.id} value={env.id}>{env.name}</option>
                              ))}
                            </Select>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            disabled={!defaultEnvId || enabledPageCount === 0 || testAllBusy}
                            loading={testAllBusy}
                            onClick={() => void handleTestAll()}
                            className="gap-1.5 h-8"
                          >
                            {!testAllBusy && <Play className="h-3.5 w-3.5" />}
                            Test all{enabledPageCount > 0 ? ` (${enabledPageCount})` : ""}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleScan()}
                            loading={scanActive && !canForceReplaceScan}
                            className="h-8"
                          >
                            {!(scanActive && !canForceReplaceScan) && <ArrowsClockwise className="h-3.5 w-3.5" />}
                            {scanActive ? (canForceReplaceScan ? "Replace scan" : "Scanning...") : "Scan app"}
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                        {enabledFilteredPages.map(page => (
                          <div
                            key={page.id}
                            className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/30 flex flex-col gap-2 min-h-[8rem]"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <Link
                                to={`/pages/${page.id}`}
                                className="min-w-0 flex-1 space-y-1 group/link"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <StatusDot status={page.health} />
                                  <span className="font-mono text-[13px] truncate">
                                    {page.route}
                                  </span>
                                </div>
                                {page.title && page.title !== page.route && (
                                  <p className="text-[11px] text-muted-foreground/60 truncate">
                                    {page.title}
                                  </p>
                                )}
                              </Link>
                              <div className="shrink-0 pt-0.5" onClick={e => e.preventDefault()}>
                                <Switch
                                  checked={page.enabled}
                                  onCheckedChange={v => { void handleToggleEnabled(page, v); }}
                                  aria-label={page.enabled ? "Disable testing for this page" : "Enable testing for this page"}
                                  className="scale-90"
                                />
                              </div>
                            </div>
                            <div className="mt-auto flex items-end justify-between gap-2 text-[11px]">
                              <div className="min-w-0 space-y-0.5">
                                <span className={cn(
                                  "font-medium tabular-nums block",
                                  page.issues > 0
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground/60"
                                )}>
                                  {page.issues} issue{page.issues !== 1 ? "s" : ""}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={e => {
                                    e.preventDefault();
                                    navigate(`/pages/${page.id}`);
                                  }}
                                >
                                  View
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                  disabled={!defaultEnvId}
                                  loading={runBusyId === page.id}
                                  onClick={e => {
                                    e.preventDefault();
                                    void handleRunPage(page);
                                  }}
                                  aria-label={`Run test for ${page.route}`}
                                >
                                  {runBusyId !== page.id && <Play className="h-3.5 w-3.5" />}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                  onClick={e => {
                                    e.preventDefault();
                                    setDeleteTarget(page);
                                  }}
                                  aria-label={`Remove ${page.route} from project`}
                                >
                                  <Trash className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Disabled route tiles */}
                  {disabledFilteredPages.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        Disabled routes ({disabledFilteredPages.length})
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                        {disabledFilteredPages.map(page => (
                          <div
                            key={page.id}
                            className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/30 flex flex-col gap-2 min-h-[8rem] opacity-60"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <Link
                                to={`/pages/${page.id}`}
                                className="min-w-0 flex-1 space-y-1 group/link"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <StatusDot status={page.health} />
                                  <span className="font-mono text-[13px] truncate line-through">
                                    {page.route}
                                  </span>
                                </div>
                                {page.title && page.title !== page.route && (
                                  <p className="text-[11px] text-muted-foreground/60 truncate">
                                    {page.title}
                                  </p>
                                )}
                              </Link>
                              <div className="shrink-0 pt-0.5" onClick={e => e.preventDefault()}>
                                <Switch
                                  checked={page.enabled}
                                  onCheckedChange={v => { void handleToggleEnabled(page, v); }}
                                  aria-label={page.enabled ? "Disable testing for this page" : "Enable testing for this page"}
                                  className="scale-90"
                                />
                              </div>
                            </div>
                            <div className="mt-auto flex items-end justify-between gap-2 text-[11px]">
                              <div className="min-w-0 space-y-0.5">
                                <span
                                  className={cn(
                                    "font-medium tabular-nums block",
                                    page.issues > 0
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-muted-foreground/60",
                                  )}
                                >
                                  {page.issues} issue{page.issues !== 1 ? "s" : ""}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={e => {
                                    e.preventDefault();
                                    navigate(`/pages/${page.id}`);
                                  }}
                                >
                                  View
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                  disabled
                                  aria-label={`Run test for ${page.route}`}
                                >
                                  <Play className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                  onClick={e => {
                                    e.preventDefault();
                                    setDeleteTarget(page);
                                  }}
                                  aria-label={`Remove ${page.route} from project`}
                                >
                                  <Trash className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {filteredPages.length === 0 && (filter || healthFilter !== "all") && (
                    <div className="text-center py-8 text-[13px] text-muted-foreground">
                      No routes matching current filters
                    </div>
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      </div>

      <Dialog open={deleteTarget != null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove route from project?</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  This removes <span className="font-mono text-foreground">{deleteTarget.route}</span> from your
                  catalog. Flow edges and run history for this route are deleted. You can add it again with a scan.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              loading={deleteBusy}
              onClick={() => void confirmDeletePage()}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
