import React from "react";
import { useNavigate } from "react-router-dom";
import {
  SquaresFour,
  Pulse,
  WarningCircle,
  Spinner,
  CaretRight,
  Globe,
  Scan,
  FlowArrow,
  Play,
  Circle,
  Check,
  X,
  Sparkle,
  ChartPie,
  CurrencyDollar,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusVariant, duration, relativeTime, formatCost, formatRunCost, runListLabel } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchProjectOverview, fetchProjectRuns, fetchProjectBugs,
  fetchEnvironments, fetchPages, fetchTests,
} from "@/projectApi";

// ─── Setup steps ──────────────────────────────────────────────────────────────

type StepStatus = "complete" | "current" | "upcoming";

interface SetupStep {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  href: string;
  buttonLabel: string;
}

const SETUP_STEPS: SetupStep[] = [
  {
    key: "environment",
    label: "Setup App Environment",
    description: "Setup details of your website or webapp you want to test.",
    icon: Globe,
    href: "/environments",
    buttonLabel: "Add environment",
  },
  {
    key: "scan",
    label: "Scan your app",
    description:
      "Kery scans your app and learns its routes, flows, and interactions so testing knows where to focus.",
    icon: Scan,
    href: "/pages",
    buttonLabel: "Scan routes",
  },
  {
    key: "flow",
    label: "Run your first test on app",
    description:
      "Create your first custom test, or let the agent explore without a script.",
    icon: FlowArrow,
    href: "/tests",
    buttonLabel: "Create flow",
  },
  {
    key: "run",
    label: "Run your first test",
    description:
      "Execute tests in a real browser and surface bugs and issues you might have missed.",
    icon: Play,
    href: "/tests",
    buttonLabel: "Run test",
  },
];

const setupDismissStorageKey = (projectId: string) =>
  `kery_overview_setup_dismissed_${projectId}`;

function SetupChecklist({
  completedSteps,
  navigate,
  onDismiss,
}: {
  completedSteps: Set<string>;
  navigate: (path: string) => void;
  onDismiss: () => void;
}) {
  let foundCurrent = false;

  return (
    <Card className="overflow-hidden border-border/80">
      <div className="flex items-start justify-between gap-3 p-4 pb-2 border-b border-border/60 bg-muted/20">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-foreground">Get started</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          Skip
        </Button>
      </div>
      <CardContent className="p-4 pt-4">

      {/* Stepper — fixed-width left column for dots + lines */}
      <div className="relative">
        {SETUP_STEPS.map((step, i) => {
          const done = completedSteps.has(step.key);
          let status: StepStatus = "upcoming";
          if (done) {
            status = "complete";
          } else if (!foundCurrent) {
            status = "current";
            foundCurrent = true;
          }

          const isLast = i === SETUP_STEPS.length - 1;

          return (
            <div key={step.key} className="flex gap-4">
              {/* Left column: dot + line */}
              <div className="flex flex-col items-center w-6 flex-shrink-0">
                {/* Dot */}
                {done ? (
                  <div className="h-6 w-6 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
                    <Check className="h-3.5 w-3.5 text-primary" />
                  </div>
                ) : status === "current" ? (
                  <div className="h-6 w-6 rounded-full border-2 border-primary flex items-center justify-center flex-shrink-0">
                    <Circle className="h-2 w-2 fill-primary text-primary" />
                  </div>
                ) : (
                  <div className="h-6 w-6 rounded-full border-2 border-border flex-shrink-0" />
                )}
                {/* Connecting line */}
                {!isLast && (
                  <div className={cn("w-px flex-1 min-h-[16px]", done ? "bg-primary/30" : "bg-border")} />
                )}
              </div>

              {/* Right column: content */}
              <div className={cn(
                "flex-1 pb-6 min-w-0",
                isLast && "pb-0",
              )}>
                <div className={cn(
                  "rounded-lg transition-colors",
                  status === "current" && "bg-card border border-border p-4 -mt-1",
                  status === "upcoming" && "opacity-40",
                )}>
                  <div className="flex items-center gap-2">
                    <step.icon className={cn(
                      "h-4 w-4 flex-shrink-0",
                      done ? "text-primary/60" : status === "current" ? "text-foreground" : "text-muted-foreground",
                    )} />
                    <span className={cn(
                      "text-[13px] font-medium",
                      done ? "text-muted-foreground line-through" : "text-foreground",
                    )}>
                      {step.label}
                    </span>
                  </div>
                  <p className={cn(
                    "text-[12px] text-muted-foreground mt-1 ml-6",
                    status === "current" && "mt-1",
                  )}>
                    {step.description}
                  </p>
                  {status === "current" && (
                    <div className="ml-6 mt-3">
                      <Button size="sm" onClick={() => navigate(step.href)}>
                        {step.buttonLabel}
                        <CaretRight className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

        {/* Progress */}
        <div className="mt-6 flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${(completedSteps.size / SETUP_STEPS.length) * 100}%` }}
            />
          </div>
          <span className="text-[11px] font-mono text-muted-foreground">
            {completedSteps.size}/{SETUP_STEPS.length}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Dashboard (shown after setup complete) ──────────────────────────────────

const SEVERITY_DOT: Record<string, string> = {
  high: "bg-status-fail",
  medium: "bg-status-warn",
  low: "bg-zinc-400 dark:bg-zinc-500",
};

type PageCoverageStats = {
  total: number;
  tested: number;
  clean: number;
  withIssues: number;
  stale: number;
  untested: number;
};

function PageCoverageKpi({ coverage }: { coverage: PageCoverageStats | null }) {
  const total = coverage?.total ?? 0;
  const pass = coverage?.clean ?? 0;
  const regress = coverage?.stale ?? 0;
  const fail = coverage?.withIssues ?? 0;
  const untested = coverage?.untested ?? 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2 min-h-[88px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Route coverage
        </span>
        <ChartPie className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
      {total === 0 ? (
        <p className="text-[12px] text-muted-foreground leading-snug">No scanned routes yet. Run a crawl to map your app.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {Math.round(((pass + regress + fail) / total) * 100)}
            </span>
            <span className="text-[12px] text-muted-foreground">% tested</span>
          </div>
          <div className="flex h-2 w-full rounded-full overflow-hidden gap-px bg-border/40">
            {pass > 0 && (
              <div
                className="min-w-[3px] rounded-l-sm bg-status-pass"
                style={{ flex: pass }}
                title={`${pass} passing`}
              />
            )}
            {regress > 0 && (
              <div
                className="min-w-[3px] bg-status-warn"
                style={{ flex: regress }}
                title={`${regress} regressing`}
              />
            )}
            {fail > 0 && (
              <div
                className="min-w-[3px] bg-status-fail"
                style={{ flex: fail }}
                title={`${fail} failed`}
              />
            )}
            {untested > 0 && (
              <div
                className="min-w-[3px] rounded-r-sm bg-muted-foreground/25"
                style={{ flex: untested }}
                title={`${untested} untested`}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            <span className="text-status-pass">{pass} pass</span>
            {" · "}
            <span className="text-status-warn">{regress} regress</span>
            {" · "}
            <span className="text-status-fail">{fail} fail</span>
            {" · "}
            <span className="text-muted-foreground">{untested} untested</span>
            <span className="text-muted-foreground/70"> · {total} routes</span>
          </p>
        </>
      )}
    </div>
  );
}

function Dashboard({
  overview,
  runs,
  bugs,
  coverage,
  navigate,
}: {
  overview: any;
  runs: any[];
  bugs: any[];
  coverage: PageCoverageStats | null;
  navigate: (path: string) => void;
}) {
  const totalCost = overview?.totalCostUsd ?? 0;
  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Total Runs" value={overview?.totalRuns ?? 0} icon={<Pulse className="h-4 w-4" />} />
        <PageCoverageKpi coverage={coverage} />
        <KpiCard
          label="Project spend"
          value={formatCost(totalCost)}
          icon={<CurrencyDollar className="h-4 w-4" />}
        />
        <KpiCard label="Running" value={overview?.running ?? 0} icon={<Spinner className="h-4 w-4 animate-spin" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Runs */}
        <Card>
          <div className="flex items-center justify-between p-4 pb-2">
            <span className="text-[14px] font-medium">Recent Runs</span>
            <Button variant="ghost" size="sm" onClick={() => navigate("/runs")} className="h-7 text-[12px] gap-1">
              View all <CaretRight className="h-3 w-3" />
            </Button>
          </div>
          <CardContent className="pt-0">
            {runs.length === 0 ? (
              <EmptyState icon={<Pulse className="h-5 w-5" />} title="No runs yet" className="py-8" />
            ) : (
              <div className="divide-y divide-border">
                {runs.map((r: any) => (
                  <button
                    key={r.id}
                    onClick={() => navigate(`/runs/${r.id}`)}
                    className="group w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-accent/40 transition-colors rounded"
                  >
                    <StatusDot status={r.status} />
                    <span className="flex-1 text-[13px] text-foreground truncate">
                      {runListLabel(r)}
                    </span>
                    <Badge variant={statusVariant(r.status)} dot className="flex-shrink-0 text-[10px]">
                      {r.status}
                    </Badge>
                    <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 tabular-nums">
                      {formatRunCost(r)}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0">
                      {duration(r.started_at, r.completed_at)}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/60 flex-shrink-0">
                      {relativeTime(r.completed_at ?? r.started_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Issues */}
        <Card>
          <div className="flex items-center justify-between p-4 pb-2">
            <span className="text-[14px] font-medium">Recent Issues</span>
            <Button variant="ghost" size="sm" onClick={() => navigate("/bugs")} className="h-7 text-[12px] gap-1">
              View all <CaretRight className="h-3 w-3" />
            </Button>
          </div>
          <CardContent className="pt-0">
            {bugs.length === 0 ? (
              <EmptyState icon={<WarningCircle className="h-5 w-5" />} title="No issues found" className="py-8" />
            ) : (
              <div className="divide-y divide-border">
                {bugs.map((bug: any, i: number) => (
                  <button
                    key={bug.id ?? i}
                    onClick={() => bug.run_id && navigate(`/runs/${bug.run_id}`)}
                    className="group w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-accent/40 transition-colors rounded"
                  >
                    <span className={cn("h-2 w-2 rounded-full flex-shrink-0", SEVERITY_DOT[bug.severity] ?? "bg-muted-foreground/40")} />
                    <span className="flex-1 text-[13px] text-foreground truncate">{bug.name || "Issue"}</span>
                    {bug.category && <Badge variant="outline" className="text-[10px]">{bug.category}</Badge>}
                    <span className="text-[11px] font-mono text-muted-foreground/60 flex-shrink-0">
                      {relativeTime(bug.reported_at ?? bug.reportedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export const Overview: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();

  const [loading, setLoading] = React.useState(true);
  const [overview, setOverview] = React.useState<any>(null);
  const [runs, setRuns] = React.useState<any[]>([]);
  const [bugs, setBugs] = React.useState<any[]>([]);
  const [pageCoverage, setPageCoverage] = React.useState<PageCoverageStats | null>(null);
  const [completedSteps, setCompletedSteps] = React.useState<Set<string>>(new Set());
  const [setupDone, setSetupDone] = React.useState(false);
  const [setupDismissed, setSetupDismissed] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!currentProjectId) return;
    setSetupDismissed(localStorage.getItem(setupDismissStorageKey(currentProjectId)) === "true");
  }, [currentProjectId]);

  const dismissSetup = React.useCallback(() => {
    if (!currentProjectId) return;
    localStorage.setItem(setupDismissStorageKey(currentProjectId), "true");
    setSetupDismissed(true);
  }, [currentProjectId]);

  const showSetupGuideAgain = React.useCallback(() => {
    if (!currentProjectId) return;
    localStorage.removeItem(setupDismissStorageKey(currentProjectId));
    setSetupDismissed(false);
  }, [currentProjectId]);

  React.useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);

    Promise.all([
      fetchEnvironments(currentProjectId).catch(() => ({ environments: [] })),
      fetchPages(currentProjectId).catch(() => ({ pages: [] })),
      fetchTests(currentProjectId).catch(() => ({ tests: [] })),
      fetchProjectRuns(currentProjectId).catch(() => ({ runs: [] })),
      fetchProjectOverview(currentProjectId).catch(() => null),
      fetchProjectBugs(currentProjectId).catch(() => ({ bugs: [] })),
    ]).then(([envRes, pagesRes, testsRes, runsRes, ov, bugsRes]) => {
      const envs = envRes.environments ?? [];
      const pages = pagesRes.pages ?? [];
      const tests = testsRes.tests ?? [];
      const allRuns = runsRes.runs ?? [];
      const allBugs = bugsRes.bugs ?? [];

      const steps = new Set<string>();
      if (envs.length > 0) steps.add("environment");
      if (pages.length > 0) steps.add("scan");
      if (tests.length > 0) steps.add("flow");
      if (allRuns.length > 0) steps.add("run");

      setCompletedSteps(steps);
      setSetupDone(steps.size === 4);
      setOverview(ov);
      setPageCoverage((pagesRes as { coverage?: PageCoverageStats }).coverage ?? null);
      setRuns(allRuns.slice(0, 10));
      setBugs(allBugs.slice(0, 10));
      setLoading(false);
    });
  }, [currentProjectId]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<SquaresFour className="h-4 w-4" />} title="Overview" />
        <EmptyState
          icon={<SquaresFour className="h-6 w-6" />}
          title="No project selected"
          description="Create or select a project to get started."
        />
      </div>
    );
  }

  const showSetupPanel = !setupDone && !setupDismissed;

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<SquaresFour className="h-4 w-4" />} title="Overview">
        {!loading && !setupDone && setupDismissed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={showSetupGuideAgain}
          >
            <Sparkle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Show setup guide</span>
            <span className="sm:hidden">Setup guide</span>
          </Button>
        )}
      </PageHeader>

      <div className="p-6 animate-fade-in">
        {loading ? (
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start w-full">
            <div className="flex-1 min-w-0 space-y-6 w-full">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-[72px] rounded-lg" />
                ))}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Skeleton className="h-[220px] rounded-lg" />
                <Skeleton className="h-[220px] rounded-lg" />
              </div>
            </div>
            <aside className="hidden lg:block w-full lg:w-[min(100%,320px)] lg:flex-shrink-0">
              <Skeleton className="h-[320px] rounded-lg" />
            </aside>
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col lg:flex-row gap-6 lg:gap-8 items-start w-full",
              !showSetupPanel && "max-w-[1600px] mx-auto",
            )}
          >
            <div className="flex-1 min-w-0 w-full space-y-6">
              <Dashboard overview={overview} runs={runs} bugs={bugs} coverage={pageCoverage} navigate={navigate} />
            </div>
            {showSetupPanel && (
              <aside className="w-full lg:w-[min(100%,340px)] lg:max-w-[40%] lg:flex-shrink-0 lg:sticky lg:top-6 lg:self-start">
                <SetupChecklist
                  completedSteps={completedSteps}
                  navigate={navigate}
                  onDismiss={dismissSetup}
                />
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
