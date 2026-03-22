import React from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Layers, RefreshCw, ChevronRight, Search, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchPages, fetchEnvironments, triggerScan, fetchScanStatus,
} from "@/projectApi";

type Page = {
  id: string;
  route: string;
  title: string;
  health: "clean" | "issues" | "stale" | "untested";
  issues: number;
  enabled: boolean;
  formCount: number;
  interactionCount: number;
};

type Coverage = {
  total: number;
  tested: number;
  clean: number;
  withIssues: number;
  stale: number;
  untested: number;
};

type LastScan = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  pages_visited: number | null;
  cost_usd: number | null;
};

const HEALTH_FILTERS = ["all", "clean", "issues", "stale", "untested"] as const;
type HealthFilter = (typeof HEALTH_FILTERS)[number];

const HEALTH_LABEL: Record<string, string> = {
  all: "All",
  clean: "Clean",
  issues: "Issues",
  stale: "Stale",
  untested: "Untested",
};

export function Pages() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const pid = currentProject?.id;

  const [pages, setPages] = React.useState<Page[]>([]);
  const [coverage, setCoverage] = React.useState<Coverage | null>(null);
  const [lastScan, setLastScan] = React.useState<LastScan | null>(null);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [scanning, setScanning] = React.useState(false);
  const [rateLimited, setRateLimited] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState<HealthFilter>("all");

  const loadData = React.useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    try {
      const [pagesRes, envsRes] = await Promise.all([
        fetchPages(pid),
        fetchEnvironments(pid),
      ]);
      setPages(pagesRes.pages || []);
      setCoverage(pagesRes.coverage || null);
      setLastScan(pagesRes.lastScan || null);
      setEnvironments((envsRes as any).environments || []);
    } catch {}
    setLoading(false);
  }, [pid]);

  React.useEffect(() => { loadData(); }, [loadData]);

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
    setScanning(true);
    setRateLimited(false);
    try {
      const res = await triggerScan(pid, force);
      if (res?._status === 429) {
        setRateLimited(true);
        setScanning(false);
        return;
      }
      const poll = setInterval(async () => {
        const status = await fetchScanStatus(pid);
        if (status.scan && status.scan.status !== "running") {
          clearInterval(poll);
          setScanning(false);
          loadData();
        }
      }, 3000);
    } catch {
      setScanning(false);
    }
  }

  if (!pid) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Layers className="h-4 w-4" />} title="Pages" />
        <EmptyState
          icon={<Layers className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view pages."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Layers className="h-4 w-4" />} title="Pages">
        {lastScan?.completed_at && (
          <span className="text-[11px] text-muted-foreground/50">
            Scanned {relativeTime(lastScan.completed_at)}
          </span>
        )}
        <Button
          size="sm"
          variant={pages.length === 0 ? "default" : "outline"}
          onClick={() => handleScan()}
          loading={scanning}
        >
          {!scanning && <RefreshCw className="h-3.5 w-3.5" />}
          {scanning ? "Scanning..." : pages.length === 0 ? "Scan my app" : "Re-scan"}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 w-full max-w-4xl mx-auto space-y-4 animate-fade-in">

          {/* Scanning progress */}
          {scanning && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0" />
              <div>
                <p className="text-[13px] font-medium text-foreground">Scanning your app...</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Discovering pages, forms, and interactions. Usually 1-2 minutes.
                </p>
              </div>
            </div>
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
              icon={<Layers className="h-8 w-8" />}
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
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
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

                          {(page.formCount > 0 || page.interactionCount > 0) && (
                            <span className="text-[11px] font-mono text-muted-foreground/40 flex-shrink-0 hidden md:block">
                              {page.formCount > 0 && `${page.formCount}f`}
                              {page.formCount > 0 && page.interactionCount > 0 && " "}
                              {page.interactionCount > 0 && `${page.interactionCount}i`}
                            </span>
                          )}

                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 flex-shrink-0" />
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
