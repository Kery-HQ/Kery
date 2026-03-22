import React from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { RunList } from "../components/RunList";
import { useProject } from "../lib/projectContext";
import { fetchProjectRuns } from "../projectApi";

export const Runs: React.FC = () => {
  const { currentProjectId } = useProject();
  const [runs, setRuns] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchProjectRuns(currentProjectId).catch(() => ({ runs: [] }));
    setRuns(res.runs || []);
    setLoading(false);
  }

  React.useEffect(() => {
    load();
  }, [currentProjectId]);

  // Auto-refresh while any run is running
  React.useEffect(() => {
    const hasRunning = runs.some((r) => r.status === "running");
    if (!hasRunning) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [runs]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex items-center justify-between px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Runs</span>
          {!loading && runs.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground ml-1">{runs.length}</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={load} className="gap-1.5 h-8">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-6 w-full">
          {!currentProjectId ? (
            <p className="text-[13px] text-muted-foreground text-center py-24">Select a project to view runs.</p>
          ) : loading ? (
            <RunList runs={[]} loading />
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
                <Activity className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-semibold text-foreground">No runs yet</p>
              <p className="text-[13px] text-muted-foreground mt-1">Trigger a run from the Flows page.</p>
            </div>
          ) : (
            <RunList runs={runs} title="All runs" />
          )}
        </div>
      </div>
    </div>
  );
};
