import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Layers, CheckCircle2, AlertTriangle, HelpCircle,
  FileText, MousePointerClick, Layout, Link2, Brain, Play, Clock, Loader2, Trash2,
  Repeat,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import { fetchPageDetail, fetchPageMemory, fetchEnvironments, runDestination, resetPageData } from "../projectApi";
import type { MemoryEntry } from "../projectApi";
import { RegressionPlanView } from "./TestsPlans";

const HEALTH_ICONS: Record<string, React.ReactNode> = {
  clean: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  issues: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  stale: <AlertTriangle className="h-4 w-4 text-orange-400" />,
  untested: <HelpCircle className="h-4 w-4 text-muted-foreground/50" />,
};

type PageData = {
  page: {
    id: string;
    normalized_route: string;
    title: string;
    health_status: string;
    issues_count: number;
    enabled: boolean;
    forms_json?: Array<{ id?: string; fields?: any[]; submitText?: string }>;
    buttons_json?: Array<{ text: string; selector: string }>;
    interactions_json?: Array<{ trigger: string; revealed: string; fields: string[]; heading: string }>;
    nav_links?: string[];
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
    started_at?: string;
    completed_at?: string | null;
    trigger_ref?: string;
  }>;
};

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        {icon}
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function PageDetail() {
  const { destinationId } = useParams<{ destinationId: string }>();
  const navigate = useNavigate();
  const { currentProjectId, currentProject } = useProject();
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
        <div className="flex items-center gap-2 px-8 py-4 border-b border-border">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading page...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-8 py-6 max-w-2xl mx-auto space-y-4">
          <button
            onClick={() => navigate("/pages")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Pages
          </button>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-foreground">
            {error || "Page not found"}
          </div>
        </div>
      </div>
    );
  }

  const { page, recentRuns } = data;
  const forms = page.forms_json || [];
  const buttons = page.buttons_json || [];
  const interactions = page.interactions_json || [];
  const navLinks = page.nav_links || [];
  const hasRegressionPlan = page.regression_plan && page.regression_plan.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border bg-card px-8 py-4">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => navigate("/pages")}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            {HEALTH_ICONS[page.health_status] || HEALTH_ICONS.untested}
            <div>
              <h1 className="font-mono text-base font-semibold text-foreground">{page.normalized_route}</h1>
              {page.title && (
                <p className="text-xs text-muted-foreground mt-0.5">{page.title}</p>
              )}
            </div>
            {page.issues_count > 0 && (
              <Badge variant="warning" className="text-[10px]">
                {page.issues_count} issue{page.issues_count !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {confirmReset ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5">
                <span className="text-[12px] text-destructive">Delete all page data?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleReset}
                  disabled={resetting}
                  className="h-7 gap-1 text-[11px]"
                >
                  {resetting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Yes, reset
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmReset(false)}
                  className="h-7 text-[11px]"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmReset(true)}
                className="gap-1.5 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Reset data
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleRun}
              disabled={running || !page.enabled || !defaultEnvId}
              className="gap-1.5"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run this page
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Forms */}
          {forms.length > 0 && (
            <Section
              icon={<FileText className="h-4 w-4 text-muted-foreground" />}
              title={`Forms (${forms.length})`}
            >
              <ul className="space-y-3">
                {forms.map((f, i) => (
                  <li key={i} className="rounded border border-border bg-muted/20 p-3 text-sm">
                    <div className="font-medium text-foreground mb-1">
                      {f.submitText ? `Submit: "${f.submitText}"` : `Form ${i + 1}`}
                    </div>
                    {f.fields && f.fields.length > 0 && (
                      <ul className="text-muted-foreground text-xs space-y-0.5 mt-1">
                        {f.fields.map((field: any, j: number) => (
                          <li key={j}>
                            {field.label || field.name} {field.required ? "(required)" : ""}
                            {field.type ? ` \u00b7 ${field.type}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Buttons */}
          {buttons.length > 0 && (
            <Section
              icon={<MousePointerClick className="h-4 w-4 text-muted-foreground" />}
              title={`Buttons (${buttons.length})`}
            >
              <ul className="flex flex-wrap gap-2">
                {buttons.map((b, i) => (
                  <li key={i}>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {b.text}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Interactions */}
          {interactions.length > 0 && (
            <Section
              icon={<Layout className="h-4 w-4 text-muted-foreground" />}
              title={`Interactions (${interactions.length})`}
            >
              <ul className="space-y-2 text-sm">
                {interactions.map((ix, i) => (
                  <li key={i} className="flex items-center gap-2 text-muted-foreground">
                    <span className="font-medium text-foreground">{ix.trigger}</span>
                    <span>\u2192</span>
                    <span>{ix.revealed}</span>
                    {ix.heading && <span className="text-xs">({ix.heading})</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Nav links */}
          {navLinks.length > 0 && (
            <Section
              icon={<Link2 className="h-4 w-4 text-muted-foreground" />}
              title={`Nav links (${navLinks.length})`}
            >
              <ul className="flex flex-wrap gap-2">
                {navLinks.map((link, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs text-muted-foreground">{link}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Regression Script */}
          {hasRegressionPlan && (
            <Section
              icon={<Repeat className="h-4 w-4 text-muted-foreground" />}
              title="Regression script"
            >
              <div>
                <div className="flex items-center gap-2 mb-2">
                  {page.plan_status === "ready" ? (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                      Active
                    </span>
                  ) : page.plan_status === "stale" ? (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      Stale
                    </span>
                  ) : null}
                  {(page.plan_success_count ?? 0) > 0 && (
                    <span className="text-[10px] text-muted-foreground/50 ml-auto">
                      {page.plan_success_count} successful replay{page.plan_success_count !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <RegressionPlanView steps={page.regression_plan!} />
              </div>
            </Section>
          )}

          {/* Memory */}
          <Section
            icon={<Brain className="h-4 w-4 text-muted-foreground" />}
            title={`Page memory (${memory.length})`}
          >
            {memory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No memory entries for this page yet.</p>
            ) : (
              <ul className="space-y-2">
                {memory.map((e) => (
                  <li key={e.id} className="rounded border border-border bg-muted/20 px-3 py-2 text-sm">
                    <span className="font-medium text-foreground">{e.type}</span>
                    {e.summary && <span className="text-muted-foreground ml-2">-- {e.summary}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Recent runs */}
          <Section
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            title={`Recent runs (${recentRuns.length})`}
          >
            {recentRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs for this page yet.</p>
            ) : (
              <ul className="space-y-2">
                {recentRuns.map((run) => (
                  <li key={run.id}>
                    <button
                      onClick={() => navigate(`/runs/${run.id}`)}
                      className="flex items-center gap-2 text-sm text-left w-full rounded border border-border bg-muted/20 px-3 py-2 hover:bg-accent/30 transition-colors"
                    >
                      <span className={cn(
                        run.status === "passed" && "text-green-600 dark:text-green-400",
                        run.status === "failed" && "text-red-600 dark:text-red-400",
                        run.status === "running" && "text-amber-600 dark:text-amber-400",
                      )}>
                        {run.status}
                      </span>
                      <span className="text-muted-foreground truncate flex-1">
                        {run.started_at ? new Date(run.started_at).toLocaleString() : run.id?.slice(0, 8)}
                      </span>
                      {run.summary && (
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{run.summary}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
