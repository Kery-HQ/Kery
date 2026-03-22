import React from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Layers, FlaskConical, Activity, AlertTriangle,
  Globe, Brain, Settings, Search, Play, Scan, Plus,
} from "lucide-react";
import { useProject } from "@/lib/projectContext";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { name: "Overview", href: "/overview", icon: LayoutDashboard },
  { name: "Pages", href: "/pages", icon: Layers },
  { name: "Flows", href: "/tests", icon: FlaskConical },
  { name: "Runs", href: "/runs", icon: Activity },
  { name: "Issues", href: "/bugs", icon: AlertTriangle },
  { name: "Environments", href: "/environments", icon: Globe },
  { name: "Memory", href: "/memory", icon: Brain },
  { name: "Settings", href: "/settings", icon: Settings },
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { projects, currentProjectId, setCurrentProjectId } = useProject();
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

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
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
        <Command
          className="w-full max-w-lg rounded-lg border border-border bg-popover shadow-2xl overflow-hidden animate-scale-in"
          loop
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
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
                value="Scan pages"
                onSelect={() => go("/pages")}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground cursor-default aria-selected:bg-accent"
              >
                <Scan className="h-4 w-4 text-muted-foreground" />
                Scan pages
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
