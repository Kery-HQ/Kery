import React from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import {
  SquaresFour,
  Stack,
  FlowArrow,
  Pulse,
  Warning,
  Globe,
  Brain,
  Gear,
  MagnifyingGlass,
  Play,
  Scan,
  Plus,
} from "@phosphor-icons/react";
import { useProject } from "@/lib/projectContext";
import { cn } from "@/lib/utils";
import { fetchTests, fetchProjectRuns, fetchPages } from "@/projectApi";
import { runListLabel } from "@/lib/formatters";

const NAV_ITEMS = [
  { name: "Overview", href: "/overview", icon: SquaresFour },
  { name: "Routes", href: "/pages", icon: Stack },
  { name: "Flows", href: "/tests", icon: FlowArrow },
  { name: "Runs", href: "/runs", icon: Pulse },
  { name: "Issues", href: "/bugs", icon: Warning },
  { name: "Credentials", href: "/environments", icon: Globe },
  { name: "Memory", href: "/memory", icon: Brain },
  { name: "Platform Settings", href: "/settings", icon: Gear },
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { projects, currentProjectId, setCurrentProjectId } = useProject();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [entities, setEntities] = React.useState<{
    tests: { id: string; name: string; intent?: string | null }[];
    runs: any[];
    pages: { id: string; route: string; title: string }[];
  } | null>(null);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  React.useEffect(() => {
    if (!open || !currentProjectId) {
      if (!open) setEntities(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetchTests(currentProjectId),
      fetchProjectRuns(currentProjectId),
      fetchPages(currentProjectId),
    ])
      .then(([testsRes, runsRes, pagesRes]) => {
        if (cancelled) return;
        const runs = (runsRes.runs ?? []).slice().sort((a: any, b: any) => {
          const ta = new Date(a.started_at ?? 0).getTime();
          const tb = new Date(b.started_at ?? 0).getTime();
          return tb - ta;
        });
        setEntities({
          tests: (testsRes.tests ?? []).filter(Boolean).slice(0, 80),
          runs: runs.slice(0, 80),
          pages: (pagesRes.pages ?? []).slice(0, 80),
        });
      })
      .catch(() => {
        if (!cancelled) setEntities({ tests: [], runs: [], pages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentProjectId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function go(href: string) {
    navigate(href);
    onOpenChange(false);
  }

  function switchProject(id: string) {
    setCurrentProjectId(id);
    navigate("/overview");
    onOpenChange(false);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[20vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      onClick={() => onOpenChange(false)}
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Command
          className="w-full max-w-lg rounded-lg border border-border bg-popover shadow-2xl overflow-hidden animate-scale-in"
          loop
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <MagnifyingGlass className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <Command.Input
              ref={inputRef}
              placeholder="Type a command or search..."
              className="flex h-10 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none"
            />
          </div>
          <Command.List className="max-h-72 overflow-y-auto p-1.5">
            <Command.Empty className="py-6 text-center text-[13px] text-muted-foreground">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {NAV_ITEMS.map((item) => (
                <Command.Item
                  key={item.href}
                  value={item.name}
                  onSelect={() => go(item.href)}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
                >
                  <item.icon className="h-4 w-4 text-muted-foreground" />
                  {item.name}
                </Command.Item>
              ))}
            </Command.Group>

            {currentProjectId && entities && entities.tests.length > 0 && (
              <>
                <Command.Separator className="my-1.5 h-px bg-border" />
                <Command.Group heading="Flows" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {entities.tests.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`flow ${t.name} ${t.intent ?? ""}`}
                      onSelect={() => {
                        navigate("/tests", { state: { selectTestId: t.id } });
                        onOpenChange(false);
                      }}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
                    >
                      <FlowArrow className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="min-w-0 truncate">{t.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}

            {currentProjectId && entities && entities.runs.length > 0 && (
              <>
                <Command.Separator className="my-1.5 h-px bg-border" />
                <Command.Group heading="Runs" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {entities.runs.map((r: any) => (
                    <Command.Item
                      key={r.id}
                      value={`run ${r.id} ${runListLabel(r)} ${r.status ?? ""}`}
                      onSelect={() => go(`/runs/${r.id}`)}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
                    >
                      <Pulse className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{runListLabel(r)}</span>
                      <span className="font-mono text-[11px] text-muted-foreground/70 flex-shrink-0 tabular-nums">
                        {typeof r.id === "string" ? r.id.slice(0, 8) : ""}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}

            {currentProjectId && entities && entities.pages.length > 0 && (
              <>
                <Command.Separator className="my-1.5 h-px bg-border" />
                <Command.Group heading="Routes" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {entities.pages.map((p) => (
                    <Command.Item
                      key={p.id}
                      value={`page ${p.title ?? ""} ${p.route ?? ""}`}
                      onSelect={() => go(`/pages/${p.id}`)}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
                    >
                      <Stack className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{p.title || p.route || "Route"}</span>
                      <span className="font-mono text-[11px] text-muted-foreground/60 flex-shrink-0 max-w-[40%] truncate">
                        {p.route}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}

            <Command.Separator className="my-1.5 h-px bg-border" />

            <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              <Command.Item
                value="Run ad-hoc test"
                onSelect={() => go("/tests")}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
              >
                <Play className="h-4 w-4 text-muted-foreground" />
                Run ad-hoc test
              </Command.Item>
              <Command.Item
                value="Scan routes"
                onSelect={() => go("/pages")}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
              >
                <Scan className="h-4 w-4 text-muted-foreground" />
                Scan routes
              </Command.Item>
              <Command.Item
                value="Create test flow"
                onSelect={() => go("/tests")}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
                Create test flow
              </Command.Item>
            </Command.Group>

            {projects.length > 1 && (
              <>
                <Command.Separator className="my-1.5 h-px bg-border" />
                <Command.Group heading="Switch Project" className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {projects.map((p) => (
                    <Command.Item
                      key={p.id}
                      value={`project ${p.name}`}
                      onSelect={() => switchProject(p.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] cursor-default aria-selected:bg-accent",
                        p.id === currentProjectId ? "text-primary" : "text-foreground",
                      )}
                    >
                      <div className="h-4 w-4 flex items-center justify-center rounded bg-primary/10 text-primary text-[9px] font-semibold flex-shrink-0">
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                      {p.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
