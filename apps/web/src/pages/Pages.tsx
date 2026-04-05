import React from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Stack,
  ArrowsClockwise,
  CaretRight,
  MagnifyingGlass,
  Spinner,
  ClockCounterClockwise,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { relativeTime, formatCrawlLlmCostLine, duration } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchPages, fetchEnvironments, triggerScan, fetchScanStatus, fetchCrawlRuns, fetchCrawlRun,
} from "@/projectApi";
import {
  CrawlAnalysisPanel,
  type CrawlLlmCallRecord,
  type CrawlMetadataJson,
} from "@/components/crawl-analysis-panel";
import { CrawlRunStatusPanel } from "@/components/crawl-run-status-panel";

type Page = {
  id: string;
  route: string;
  title: string;
  health: "clean" | "issues" | "stale" | "untested";
  issues: number;
  enabled: boolean;
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
  nodes_found?: number | null;
  cost_usd: number | null;
  llm_cost_breakdown_json: { linkFilterUsd?: number; suggestedFlowsUsd?: number } | null;
  crawl_metadata_json?: CrawlLiveMeta | null;
};

type CrawlLiveMeta = {
  phase?: string;
  durationMs?: number;
  baseUrl?: string;
  limits?: Record<string, unknown>;
  live?: {
    queueDepth: number;
    currentUrl: string | null;
    currentRoute: string | null;
  };
  stats?: { pagesVisited?: number; nodesFound?: number; llmCallCount?: number };
  inProgress?: boolean;
  error?: string;
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

export function Pages() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const pid = currentProject?.id;

  const [pages, setPages] = React.useState<Page[]>([]);
  const [coverage, setCoverage] = React.useState<Coverage | null>(null);
  const [lastScan, setLastScan] = React.useState<LastScan | null>(null);
  const [crawlRuns, setCrawlRuns] = React.useState<CrawlRunRow[]>([]);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  /** True while a crawl is running (including after refresh if latest run is still running). */
  const [scanActive, setScanActive] = React.useState(false);
  /** Latest row from scan/status while polling; drives live progress UI. */
  const [liveScan, setLiveScan] = React.useState<LastScan | null>(null);
  /** After POST /scan, ignore stale "completed" until this time (race with DB insert). */
  const scanExpectUntilRef = React.useRef<number | null>(null);
  /** Client clock for "stuck" detection when `started_at` is missing (race before first poll). */
  const [scanSessionStartedAt, setScanSessionStartedAt] = React.useState<number | null>(null);
  const [scanUiTick, setScanUiTick] = React.useState(0);
  const [rateLimited, setRateLimited] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState<HealthFilter>("all");
  const [scanHistoryOpen, setScanHistoryOpen] = React.useState(false);
  const [crawlDetailId, setCrawlDetailId] = React.useState<string | null>(null);
  const [crawlDetail, setCrawlDetail] = React.useState<{
    llm_calls_json?: CrawlLlmCallRecord[] | null;
    crawl_metadata_json?: CrawlMetadataJson | null;
  } | null>(null);
  const [crawlDetailLoading, setCrawlDetailLoading] = React.useState(false);

  const closeCrawlDetail = React.useCallback(() => {
    setCrawlDetailId(null);
    setCrawlDetail(null);
  }, []);

  const openCrawlDetail = React.useCallback(async (runId: string) => {
    if (!pid) return;
    setCrawlDetailId(runId);
    setCrawlDetailLoading(true);
    setCrawlDetail(null);
    try {
      const res = (await fetchCrawlRun(pid, runId)) as {
        run?: { llm_calls_json?: CrawlLlmCallRecord[] | null; crawl_metadata_json?: CrawlMetadataJson | null };
      };
      setCrawlDetail(res.run ?? null);
    } catch {
      setCrawlDetail(null);
    }
    setCrawlDetailLoading(false);
  }, [pid]);

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
      setEnvironments((envsRes as any).environments || []);
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

  // Refresh-safe: if user reloads while a crawl is running, resume polling.
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

  // Poll while a scan is active; stop when latest run is no longer running.
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

      if (expectUntil != null && Date.now() < expectUntil) {
        return;
      }

      scanExpectUntilRef.current = null;
      setScanActive(false);
      setLiveScan(null);
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

  const groupedByPrefix = React.useMemo(() => {
    const groups = new Map<string, Page[]>();
    for (const p of filteredPages) {
      const parts = p.route.split("/").filter(Boolean);
      const prefix = parts.length > 0 ? `/${parts[0]}` : "/";
      const list = groups.get(prefix) || [];
      list.push(p);
      groups.set(prefix, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredPages]);

  async function handleScan(force = false) {
    if (!pid) return;
    setRateLimited(false);
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

  const lastScanLlm = lastScan ? formatCrawlLlmCostLine(lastScan) : null;

  if (!pid) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Stack className="h-4 w-4" />} title="Pages" />
        <EmptyState
          icon={<Stack className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view pages."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Stack className="h-4 w-4" />} title="Pages">
        {lastScan?.completed_at && (
          <span className="text-[11px] text-muted-foreground/50">
            Scanned {relativeTime(lastScan.completed_at)}
            {lastScanLlm && (
              <> &middot; <span className="font-mono">{lastScanLlm}</span> LLM</>
            )}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setScanHistoryOpen(true)}
          aria-label="Scan history"
          className="gap-1.5"
        >
          <ClockCounterClockwise className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Scan history</span>
        </Button>
        <Sheet
          open={scanHistoryOpen}
          onOpenChange={o => {
            setScanHistoryOpen(o);
            if (!o) closeCrawlDetail();
          }}
        >
          <SheetContent className="flex flex-col p-0 gap-0 w-full sm:max-w-lg">
            <SheetHeader className="px-4 py-3 border-b border-border shrink-0 text-left">
              <SheetTitle>{crawlDetailId ? "Crawl analysis" : "Scan history"}</SheetTitle>
              <SheetDescription className={crawlDetailId ? "sr-only" : undefined}>
                {crawlDetailId ? "LLM calls and crawl metadata" : "Past crawl runs. Open a row for full LLM payloads and metadata."}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden px-4 pb-4 pt-2">
              {crawlDetailId ? (
                crawlDetailLoading ? (
                  <div className="space-y-2 py-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : (
                  <CrawlAnalysisPanel
                    metadata={crawlDetail?.crawl_metadata_json}
                    llmCalls={crawlDetail?.llm_calls_json}
                    onBack={closeCrawlDetail}
                  />
                )
              ) : loading ? (
                <p className="text-[12px] text-muted-foreground py-4">Loading…</p>
              ) : crawlRuns.length === 0 ? (
                <p className="text-[12px] text-muted-foreground py-4">No scans yet. Run a scan to see history here.</p>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto -mx-1">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Pages</TableHead>
                        <TableHead className="text-right">LLM cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {crawlRuns.map(run => {
                        const llm = formatCrawlLlmCostLine(run);
                        const when = run.completed_at || run.started_at;
                        return (
                          <TableRow
                            key={run.id}
                            className="cursor-pointer hover:bg-accent/50"
                            onClick={() => openCrawlDetail(run.id)}
                          >
                            <TableCell className="font-mono text-[12px] text-muted-foreground">
                              {relativeTime(when)}
                              {run.completed_at && (
                                <span className="text-muted-foreground/50"> · {duration(run.started_at, run.completed_at)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-[12px] capitalize">{run.status}</TableCell>
                            <TableCell className="text-right font-mono text-[12px] tabular-nums">
                              {run.pages_visited ?? "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                              {llm ?? "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
        <Button
          size="sm"
          variant={pages.length === 0 ? "default" : "outline"}
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
              : "Re-scan"}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 w-full max-w-4xl mx-auto space-y-4 animate-fade-in">

          {/* Scanning progress (persisted server-side; safe to refresh) */}
          {scanActive && (
            <div className="space-y-2">
              <CrawlRunStatusPanel
                variant="live"
                run={
                  liveScan ??
                  ({
                    status: "running",
                    started_at: scanSessionStartedAt
                      ? new Date(scanSessionStartedAt).toISOString()
                      : new Date().toISOString(),
                  } as LastScan)
                }
              />
              {canForceReplaceScan && (
                <p className="text-[11px] text-muted-foreground px-1">
                  No progress? Use <span className="font-medium text-foreground">Replace stuck scan</span> in the
                  header to abort this run and start a new one.
                </p>
              )}
            </div>
          )}

          {/* Latest finished scan — full detail when outcome looks wrong */}
          {!scanActive &&
            lastScan &&
            (lastScan.status === "failed" ||
              lastScan.pages_visited === 0 ||
              lastScan.crawl_metadata_json?.error ||
              (lastScan.crawl_metadata_json?.diagnostics?.hints?.length ?? 0) > 0) && (
              <CrawlRunStatusPanel variant="summary" run={lastScan} title="Latest scan (detail)" />
            )}

          {/* Rate limit */}
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

          {/* Coverage bar */}
          {coverage && coverage.total > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{coverage.tested} of {coverage.total} tested</span>
                <div className="flex items-center gap-3">
                  {coverage.clean > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {coverage.clean} clean
                    </span>
                  )}
                  {coverage.withIssues > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      {coverage.withIssues} issues
                    </span>
                  )}
                  {coverage.stale > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
                      {coverage.stale} stale
                    </span>
                  )}
                  {coverage.untested > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                      {coverage.untested} untested
                    </span>
                  )}
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                {coverage.clean > 0 && (
                  <div className="bg-emerald-500 h-full transition-all" style={{ width: `${(coverage.clean / coverage.total) * 100}%` }} />
                )}
                {coverage.withIssues > 0 && (
                  <div className="bg-amber-500 h-full transition-all" style={{ width: `${(coverage.withIssues / coverage.total) * 100}%` }} />
                )}
                {coverage.stale > 0 && (
                  <div className="bg-orange-400 h-full transition-all" style={{ width: `${(coverage.stale / coverage.total) * 100}%` }} />
                )}
                {coverage.untested > 0 && (
                  <div className="bg-muted-foreground/30 h-full transition-all" style={{ width: `${(coverage.untested / coverage.total) * 100}%` }} />
                )}
              </div>
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
              title="No pages discovered yet"
              description="Click 'Scan my app' to discover all pages, forms, and interactions."
              action={
                environments.length === 0
                  ? { label: "Add environment first", onClick: () => navigate("/environments") }
                  : undefined
              }
            />
          ) : (
            <>
              {/* Filter bar */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[180px] max-w-xs">
                  <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                  <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filter pages..."
                    className="pl-8"
                  />
                </div>
                <div className="flex items-center gap-1">
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

              {/* Page list grouped by prefix */}
              <div className="space-y-4">
                {groupedByPrefix.map(([prefix, prefixPages]) => (
                  <div key={prefix} className="space-y-0.5">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 px-1 pb-1">
                      {prefix}
                    </div>
                    <div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
                      {prefixPages.map(page => (
                        <Link
                          key={page.id}
                          to={`/pages/${page.id}`}
                          className={cn(
                            "group flex items-center gap-3 px-4 py-2 hover:bg-accent/40 transition-colors",
                            !page.enabled && "opacity-50",
                          )}
                        >
                          <StatusDot status={page.health} />

                          <span className={cn(
                            "font-mono text-[13px] flex-1 truncate min-w-0",
                            !page.enabled && "line-through",
                          )}>
                            {page.route}
                          </span>

                          {page.title && page.title !== page.route && (
                            <span className="text-[11px] text-muted-foreground/50 truncate max-w-[180px] hidden sm:block">
                              {page.title}
                            </span>
                          )}

                          {page.issues > 0 && (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium tabular-nums flex-shrink-0">
                              {page.issues} issue{page.issues !== 1 ? "s" : ""}
                            </span>
                          )}

                          <CaretRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 flex-shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {filteredPages.length === 0 && (filter || healthFilter !== "all") && (
                <div className="text-center py-8 text-[13px] text-muted-foreground">
                  No pages matching current filters
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
