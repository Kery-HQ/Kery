import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  CaretDown,
  Check,
  Plus,
  SquaresFour,
  Code,
  Path,
  ListChecks,
  Play,
  Brain,
  Bug,
  Gear,
  Sun,
  Moon,
  Monitor,
  CaretDoubleLeft,
  CaretDoubleRight,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import { createProject } from "@/projectApi";
import { getTheme, setTheme as setThemeUtil, type Theme } from "@/lib/hooks";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";

// Re-export Theme type from hooks
export type { Theme } from "@/lib/hooks";

const CORE_ITEMS = [
  { name: "Overview",     href: "/overview",      icon: SquaresFour },
  { name: "Routes",       href: "/pages",         icon: Path },
  { name: "Flows",        href: "/tests",         icon: ListChecks },
  { name: "Runs",         href: "/runs",          icon: Play },
  { name: "Issues",       href: "/bugs",          icon: Bug },
];

const TOOLS_ITEMS = [
  { name: "Credentials", href: "/environments",  icon: Code },
  { name: "Memory",       href: "/memory",        icon: Brain },
];

function Logo() {
  return (
    <img
      src="/logo/kery.png"
      alt="Kery"
      className="h-[18px] w-[18px] flex-shrink-0 object-contain [image-rendering:pixelated]"
    />
  );
}

function normalizeDomain(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) return "";
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return s.replace(/^www\./, "");
  }
}

function ProjectIcon({ project, size = 6 }: { project: { name: string; domain?: string | null }; size?: 5 | 6 }) {
  const sizeCls = size === 5 ? "h-5 w-5" : "h-6 w-6";
  return (
    <div className={cn(sizeCls, "flex items-center justify-center rounded-md bg-primary/10 text-primary font-semibold text-[10px] flex-shrink-0")}>
      {project.name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

interface NavProps {
  onOpenCommandPalette: () => void;
}

export function Nav({ onOpenCommandPalette }: NavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { projects, currentProjectId, setCurrentProjectId, refreshProjects } = useProject();

  const [theme, setThemeState] = React.useState<Theme>(getTheme);
  const setTheme = (t: Theme) => { setThemeUtil(t); setThemeState(t); };
  const cycleTheme = () => {
    const order: Theme[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const [collapsed, setCollapsed] = React.useState(() => localStorage.getItem("kery_nav_collapsed") === "true");
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [creatingProject, setCreatingProject] = React.useState(false);
  const [newProjectName, setNewProjectName] = React.useState("");
  const [newProjectDomain, setNewProjectDomain] = React.useState("");
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null;

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("kery_nav_collapsed", String(next));
  };

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setCreatingProject(false);
        setNewProjectName("");
        setNewProjectDomain("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;
    const domain = normalizeDomain(newProjectDomain);
    const res = await createProject(newProjectName.trim(), domain || undefined);
    await refreshProjects();
    if (res.project?.id) {
      setCurrentProjectId(res.project.id);
      navigate("/overview");
    }
    setCreatingProject(false);
    setNewProjectName("");
    setNewProjectDomain("");
    setDropdownOpen(false);
  }

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <nav className={cn(
      "liquid-glass-strong flex flex-col min-h-screen flex-shrink-0 transition-all duration-200 border-r",
      collapsed ? "w-12" : "w-[248px]",
    )}>
      {/* Brand */}
      <div className={cn("flex items-center h-12 glass-divider border-b", collapsed ? "px-2 justify-center" : "px-3 justify-between")}>
        <NavLink to="/overview" className="flex items-center gap-2 text-foreground dark:text-white hover:opacity-80 transition-opacity">
          <Logo />
          {!collapsed && (
            <span className="font-semibold tracking-tight text-[15px] leading-none">
              Kery
            </span>
          )}
        </NavLink>
        {!collapsed && (
          <button onClick={toggleCollapsed} className="text-foreground/35 dark:text-white/35 hover:text-foreground dark:hover:text-white transition-colors p-1 rounded-md hover:bg-black/6 dark:hover:bg-white/8">
            <CaretDoubleLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Project selector */}
      {!collapsed && (
        <div className="px-2 pt-3 pb-1">
          <div ref={dropdownRef} className="relative">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className={cn(
                  "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-semibold transition-all",
                  "text-foreground dark:text-white/90 hover:bg-black/6 dark:hover:bg-white/10",
                  dropdownOpen && "bg-black/8 dark:bg-white/12",
                )}
              >
                {currentProject ? <ProjectIcon project={currentProject} size={5} /> : (
                  <div className="flex h-5 w-5 items-center justify-center rounded-md bg-muted text-muted-foreground font-semibold text-[10px]">?</div>
                )}
                <span className="flex-1 text-left truncate text-[13px]">{currentProject?.name ?? "Select project"}</span>
                <CaretDown className={cn("h-3 w-3 text-muted-foreground/40 transition-transform", dropdownOpen && "rotate-180")} />
              </button>
              <button
                type="button"
                onClick={() => navigate("/project-settings")}
                className="h-8 w-8 shrink-0 rounded-md text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground transition-colors"
                aria-label="Project settings"
                title="Project settings"
              >
                <Gear className="h-3.5 w-3.5 mx-auto" />
              </button>
            </div>

            {dropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md overflow-hidden animate-fade-in bg-popover border border-border shadow-[var(--shadow-md)]">
                {projects.length > 0 && (
                  <div className="py-1 max-h-48 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setCurrentProjectId(p.id); setDropdownOpen(false); navigate("/overview"); }}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] hover:bg-accent transition-colors text-left"
                      >
                        <ProjectIcon project={p} size={5} />
                        <span className="flex-1 truncate">{p.name}</span>
                        {p.id === currentProjectId && <Check className="h-3 w-3 text-primary flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
                <div className="border-t border-border">
                  {creatingProject ? (
                    <div className="p-2 space-y-1.5">
                      <input autoFocus value={newProjectName}
                        onChange={(e) => setNewProjectName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newProjectName.trim()) handleCreateProject();
                          if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }
                        }}
                        placeholder="Project name"
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      />
                      <input value={newProjectDomain}
                        onChange={(e) => setNewProjectDomain(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newProjectName.trim()) handleCreateProject();
                          if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }
                        }}
                        placeholder="Domain (optional)"
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      />
                      <div className="flex gap-1.5">
                        <button onClick={handleCreateProject} disabled={!newProjectName.trim()}
                          className="text-[12px] font-medium text-primary hover:text-primary/80 disabled:opacity-40 px-2 py-0.5 rounded hover:bg-primary/5 transition-colors">Create</button>
                        <button onClick={() => { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }}
                          className="text-[12px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent transition-colors">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setCreatingProject(true)}
                      className="w-full flex items-center gap-2 px-2.5 py-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                      <Plus className="h-3.5 w-3.5" /> New project
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Cmd+K trigger */}
          <button
            onClick={onOpenCommandPalette}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 mt-1 text-[12px] text-foreground/45 dark:text-white/45 hover:text-foreground dark:hover:text-white hover:bg-black/6 dark:hover:bg-white/8 transition-colors"
          >
            <MagnifyingGlass className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Search...</span>
            <Kbd>⌘K</Kbd>
          </button>
        </div>
      )}

      {/* Collapsed: expand button */}
      {collapsed && (
        <div className="px-1.5 pt-2 pb-1 flex flex-col items-center gap-1">
          <button onClick={toggleCollapsed} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-sidebar-accent transition-colors">
            <CaretDoubleRight className="h-3.5 w-3.5" />
          </button>
          <button onClick={onOpenCommandPalette} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-sidebar-accent transition-colors">
            <MagnifyingGlass className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Nav items */}
      <ScrollArea className="flex-1">
        <div className={cn("flex flex-col", collapsed ? "px-1.5 pt-1" : "px-2 pt-1")}>
          <NavGroup items={CORE_ITEMS} location={location} collapsed={collapsed} />

          {!collapsed && (
            <div className="mt-4 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-foreground/40 dark:text-white/35 px-2.5">Configure</span>
            </div>
          )}
          {collapsed && <div className="h-px bg-sidebar-border my-2 mx-1" />}
          <NavGroup items={TOOLS_ITEMS} location={location} collapsed={collapsed} />

        </div>
      </ScrollArea>

      {/* Bottom settings */}
      <div className="px-2 pt-2 pb-1 border-t glass-divider">
        <NavItem
          item={{ name: "Platform Settings", href: "/settings", icon: Gear }}
          active={location.pathname.startsWith("/settings")}
          collapsed={collapsed}
        />
      </div>

      {/* Theme footer */}
      <div className="border-t glass-divider p-2">
        {collapsed ? (
          <div className="flex justify-center">
            <button onClick={cycleTheme} className="p-1.5 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-sidebar-accent transition-colors">
              <ThemeIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex rounded-md bg-black/6 dark:bg-white/6 p-0.5 gap-0.5">
            {([
              { mode: "light" as const, Icon: Sun, label: "Light" },
              { mode: "system" as const, Icon: Monitor, label: "System" },
              { mode: "dark" as const, Icon: Moon, label: "Dark" },
            ]).map(({ mode, Icon, label }) => (
              <button key={mode} onClick={() => setTheme(mode)} title={label}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 rounded py-1 text-[11px] font-medium transition-colors",
                  theme === mode
                    ? "bg-white/55 dark:bg-white/15 text-foreground dark:text-white shadow-sm"
                    : "text-foreground/40 dark:text-white/40 hover:text-foreground dark:hover:text-white",
                )}>
                <Icon className="h-3 w-3 flex-shrink-0" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function NavGroup({ items, location, collapsed }: {
  items: { name: string; href: string; icon: React.ElementType }[];
  location: { pathname: string };
  collapsed: boolean;
}) {
  return (
    <div className="space-y-0.5">
      {items.map((item) => (
        <NavItem key={item.name} item={item} active={location.pathname.startsWith(item.href)} collapsed={collapsed} />
      ))}
    </div>
  );
}

function NavItem({ item, active, collapsed }: { item: { name: string; href: string; icon: React.ElementType }; active: boolean; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.href}
      title={collapsed ? item.name : undefined}
        className={cn(
          "group flex items-center rounded-md text-[13px] font-semibold transition-colors relative",
          collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-[7px]",
          active
            ? "bg-black/8 dark:bg-white/12 text-foreground dark:text-white"
            : "text-foreground/60 dark:text-white/55 hover:text-foreground dark:hover:text-white hover:bg-black/6 dark:hover:bg-white/8",
        )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-r bg-foreground dark:bg-white/80" />
      )}
      <item.icon className={cn(
        "flex-shrink-0 transition-colors",
        collapsed ? "h-4 w-4" : "h-[15px] w-[15px]",
        active ? "text-foreground dark:text-white" : "text-foreground/45 dark:text-white/45 group-hover:text-foreground dark:group-hover:text-white",
      )} />
      {!collapsed && <span>{item.name}</span>}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.name}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}
