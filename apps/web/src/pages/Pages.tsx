import React from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Layers, RefreshCw, ChevronRight,
  CheckCircle2, AlertTriangle, HelpCircle, Loader2,
  Search,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import {
  fetchPages, fetchEnvironments, triggerScan,
  fetchScanStatus,
} from "../projectApi";

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

const HEALTH_DOT: Record<string, string> = {
  clean:    "bg-emerald-500",
  issues:   "bg-amber-500",
  stale:    "bg-orange-400",
  untested: "bg-muted-foreground/30",
};

const HEALTH_LABEL: Record<string, string> = {
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
      setEnvironments(envsRes.environments || []);
    } catch {}
    setLoading(false);
  }, [pid]);

  React.useEffect(() => { loadData(); }, [loadData]);

  const filteredPages = React.useMemo(() => {
    if (!filter.trim()) return pages;
    const q = filter.toLowerCase();
    return pages.filter(p => p.route.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
  }, [pages, filter]);

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

  const lastScannedText = lastScan?.completed_at
    ? timeAgo(lastScan.completed_at)
    : lastScan?.status === "running" ? "Running..." : "Never";

  const enabledCount = pages.filter(p => p.enabled).length;

  if (!pid) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center justify-between px-8 h-14 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground/60" />
            <span className="text-[14px] font-semibold text-foreground tracking-tight">Pages</span>
          </div>
        </div>
        <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
          Select a project to view pages
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 lg:px-8 h-14 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground/60" />
          <span className="text-[14px] font-semibold text-foreground tracking-tight">Pages</span>
          {pages.length > 0 && (
            <span className="text-[11px] text-muted-foreground/60 ml-1">
              {enabledCount} of {pages.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastScan && (
            <span className="text-[11px] text-muted-foreground/50">Scanned {lastScannedText}</span>
          )}
          <Button
            size="sm"
            variant={pages.length === 0 ? "default" : "outline"}
            onClick={() => handleScan()}
            disabled={scanning}
            className="gap-1.5 h-8"
          >
            {scanning
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />
            }
            {scanning ? "Scanning..." : pages.length === 0 ? "Scan my app" : "Re-scan"}
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-8 py-5 w-full max-w-4xl mx-auto space-y-4">

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
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{coverage.tested} of {coverage.total} tested</span>
                <div className="flex items-center gap-3">
                  {coverage.clean > 0 && <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{coverage.clean} clean</span>}
                  {coverage.withIssues > 0 && <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{coverage.withIssues} issues</span>}
                  {coverage.untested > 0 && <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />{coverage.untested} untested</span>}
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                {coverage.clean > 0 && (
                  <div className="bg-emerald-500 h-full" style={{ width: `${(coverage.clean / coverage.total) * 100}%` }} />
                )}
                {coverage.withIssues > 0 && (
                  <div className="bg-amber-500 h-full" style={{ width: `${(coverage.withIssues / coverage.total) * 100}%` }} />
                )}
                {coverage.stale > 0 && (
                  <div className="bg-orange-400 h-full" style={{ width: `${(coverage.stale / coverage.total) * 100}%` }} />
                )}
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : pages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-16 text-center space-y-3">
              <Layers className="h-8 w-8 text-muted-foreground/20 mx-auto" />
              <div>
                <p className="text-[13px] font-medium text-foreground">No pages discovered yet</p>
                <p className="text-[12px] text-muted-foreground mt-1">
                  Click "Scan my app" to discover all pages, forms, and interactions.
                </p>
              </div>
              {environments.length === 0 && (
                <p className="text-[12px] text-amber-600 dark:text-amber-400">
                  Add an environment first in the Environments page.
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Search filter */}
              {pages.length > 5 && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                  <input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filter pages..."
                    className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
                  />
                </div>
              )}

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
                            "group flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40 transition-colors",
                            !page.enabled && "opacity-50",
                          )}
                        >
                          <span className={cn("h-2 w-2 rounded-full flex-shrink-0", HEALTH_DOT[page.health] ?? HEALTH_DOT.untested)} />

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
                            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium flex-shrink-0">
                              {page.issues}
                            </span>
                          )}

                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 flex-shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {filteredPages.length === 0 && filter && (
                <div className="text-center py-8 text-[13px] text-muted-foreground">
                  No pages matching "{filter}"
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
