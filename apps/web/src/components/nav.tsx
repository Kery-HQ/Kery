import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown, Check, Plus,
  LayoutDashboard, Globe, FlaskConical,
  Activity, Brain, AlertTriangle, Settings,
  Sun, Moon, Monitor,
  Layers, PanelLeftClose, PanelLeft,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import { createProject } from "../projectApi";

// --- Theme ---

type Theme = "light" | "system" | "dark";
const THEME_KEY = "kery_theme";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    prefersDark ? root.classList.add("dark") : root.classList.remove("dark");
  }
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    return (localStorage.getItem(THEME_KEY) as Theme | null) ?? "system";
  });

  React.useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyTheme("system");
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  };

  return [theme, setTheme];
}

// --- Nav groups ---

const CORE_ITEMS = [
  { name: "Overview",     href: "/overview",      icon: LayoutDashboard },
  { name: "Pages",        href: "/pages",         icon: Layers },
  { name: "Flows",        href: "/tests",         icon: FlaskConical },
  { name: "Runs",         href: "/runs",          icon: Activity },
  { name: "Issues",       href: "/bugs",          icon: AlertTriangle },
];

const TOOLS_ITEMS = [
  { name: "Environments", href: "/environments",  icon: Globe },
  { name: "Memory",       href: "/memory",        icon: Brain },
];

const SETTINGS_ITEMS = [
  { name: "Settings",     href: "/settings",      icon: Settings },
];

function Logo() {
  const [src, setSrc] = React.useState<"/logo.svg" | "/logo.png">("/logo.svg");
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      className="h-5 w-5 flex-shrink-0 object-contain"
      onError={() => (src === "/logo.svg" ? setSrc("/logo.png") : setFailed(true))}
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

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

function ProjectIcon({ project, size = 6 }: { project: { name: string; domain?: string | null }; size?: 5 | 6 }) {
  const [imgError, setImgError] = React.useState(false);
  const domain = project.domain ? normalizeDomain(project.domain) : "";
  const showFavicon = domain && !imgError;
  const sizeCls = size === 5 ? "h-5 w-5" : "h-6 w-6";
  if (showFavicon) {
    return (
      <img
        src={faviconUrl(domain)}
        alt=""
        onError={() => setImgError(true)}
        className={cn(sizeCls, "flex-shrink-0 rounded-md object-contain")}
      />
    );
  }
  return (
    <div className={cn(sizeCls, "flex items-center justify-center rounded-md bg-primary/10 text-primary font-semibold text-[10px]")}>
      {project.name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projects, currentProjectId, setCurrentProjectId, refreshProjects } = useProject();
  const [theme, setTheme] = useTheme();

  const [collapsed, setCollapsed] = React.useState(() => {
    return localStorage.getItem("kery_nav_collapsed") === "true";
  });
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

  const navWidth = collapsed ? "w-[52px]" : "w-[220px]";

  return (
    <nav className={cn(
      "flex flex-col min-h-screen border-r border-sidebar-border bg-sidebar flex-shrink-0 transition-all duration-200",
      navWidth,
    )}>
      {/* Brand + collapse toggle */}
      <div className={cn("flex items-center h-14 border-b border-sidebar-border", collapsed ? "px-2 justify-center" : "px-3 justify-between")}>
        <NavLink to="/overview" className="flex items-center gap-2 text-sidebar-foreground hover:text-sidebar-foreground/90 transition-colors">
          <Logo />
          {!collapsed && <span className="text-[14px] font-semibold tracking-tight">Kery</span>}
        </NavLink>
        {!collapsed && (
          <button
            onClick={toggleCollapsed}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent/60"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        )}
        {collapsed && (
          <button
            onClick={toggleCollapsed}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent/60 absolute -right-3 top-4 bg-sidebar border border-sidebar-border rounded-full shadow-sm z-10"
            title="Expand sidebar"
          >
            <PanelLeft className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Project selector */}
      {!collapsed && (
        <div className="px-3 pt-3 pb-1">
          <div ref={dropdownRef} className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className={cn(
                "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-all duration-150",
                "text-sidebar-foreground hover:bg-sidebar-accent/60",
                dropdownOpen && "bg-sidebar-accent/60",
              )}
            >
              <div className="flex-shrink-0">
                {currentProject ? (
                  <ProjectIcon project={currentProject} size={6} />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground font-semibold text-[11px]">
                    ?
                  </div>
                )}
              </div>
              <span className="flex-1 text-left truncate">
                {currentProject ? currentProject.name : "Select project"}
              </span>
              <ChevronDown className={cn(
                "h-3.5 w-3.5 text-muted-foreground/40 transition-transform duration-150 flex-shrink-0",
                dropdownOpen && "rotate-180",
              )} />
            </button>

            {dropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border border-sidebar-border bg-sidebar shadow-xl overflow-hidden animate-fade-in">
                {projects.length > 0 && (
                  <div className="py-1 max-h-48 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setCurrentProjectId(p.id);
                          setDropdownOpen(false);
                          navigate("/overview");
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-sidebar-accent/60 transition-colors text-left"
                      >
                        <ProjectIcon project={p} size={5} />
                        <span className="flex-1 truncate">{p.name}</span>
                        {p.id === currentProjectId && (
                          <Check className="h-3 w-3 text-primary flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}

                <div className="border-t border-sidebar-border">
                  {creatingProject ? (
                    <div className="p-2.5 space-y-2">
                      <input
                        autoFocus
                        value={newProjectName}
                        onChange={(e) => setNewProjectName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newProjectName.trim()) handleCreateProject();
                          if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }
                        }}
                        placeholder="Project name"
                        className="w-full rounded-md border border-sidebar-border bg-background px-2.5 py-1.5 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      />
                      <input
                        value={newProjectDomain}
                        onChange={(e) => setNewProjectDomain(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newProjectName.trim()) handleCreateProject();
                          if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }
                        }}
                        placeholder="Domain (optional, e.g. example.com)"
                        className="w-full rounded-md border border-sidebar-border bg-background px-2.5 py-1.5 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      />
                      <div className="flex gap-1.5 pt-0.5">
                        <button
                          onClick={handleCreateProject}
                          disabled={!newProjectName.trim()}
                          className="text-[12px] font-medium text-primary hover:text-primary/80 disabled:opacity-40 px-2.5 py-1 rounded-md hover:bg-primary/5 transition-colors"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => { setCreatingProject(false); setNewProjectName(""); setNewProjectDomain(""); }}
                          className="text-[12px] text-muted-foreground hover:text-sidebar-foreground px-2.5 py-1 rounded-md hover:bg-sidebar-accent/40 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setCreatingProject(true)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New project
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Nav sections */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 flex flex-col">
        {/* Core */}
        <NavGroup items={CORE_ITEMS} location={location} collapsed={collapsed} />

        {/* Tools */}
        {!collapsed && (
          <div className="mt-4 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 px-2">Configure</span>
          </div>
        )}
        {collapsed && <div className="h-px bg-sidebar-border my-2 mx-1" />}
        <NavGroup items={TOOLS_ITEMS} location={location} collapsed={collapsed} />

        {/* Settings at bottom */}
        <div className="mt-auto pt-3 pb-1">
          {!collapsed && <div className="h-px bg-sidebar-border mb-2 mx-1" />}
          {collapsed && <div className="h-px bg-sidebar-border mb-2 mx-1" />}
          <NavGroup items={SETTINGS_ITEMS} location={location} collapsed={collapsed} />
        </div>
      </div>

      {/* Theme footer */}
      <div className={cn("border-t border-sidebar-border p-2 space-y-2", collapsed && "px-1")}>
        {!collapsed && (
          <div className="flex rounded-lg bg-sidebar-accent/50 p-0.5 gap-0.5">
            {([
              { mode: "light",  Icon: Sun,     label: "Light"  },
              { mode: "system", Icon: Monitor, label: "System" },
              { mode: "dark",   Icon: Moon,    label: "Dark"   },
            ] as const).map(({ mode, Icon, label }) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                title={label}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition-all duration-150",
                  theme === mode
                    ? "bg-card shadow-xs text-foreground"
                    : "text-muted-foreground/60 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-3 w-3 flex-shrink-0" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}

        {collapsed && (
          <div className="flex flex-col items-center gap-1">
            {([
              { mode: "light" as const, Icon: Sun },
              { mode: "dark" as const, Icon: Moon },
            ]).map(({ mode, Icon }) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  theme === mode ? "bg-card shadow-xs text-foreground" : "text-muted-foreground/40 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
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
  return (
    <NavLink
      to={item.href}
      title={collapsed ? item.name : undefined}
      className={cn(
        "group flex items-center rounded-md text-[13px] font-medium transition-all duration-150",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-[7px]",
        active
          ? "bg-primary/8 text-primary"
          : "text-sidebar-foreground/65 hover:text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
    >
      <item.icon className={cn(
        "flex-shrink-0 transition-colors",
        collapsed ? "h-4 w-4" : "h-[15px] w-[15px]",
        active ? "text-primary" : "text-muted-foreground/70 group-hover:text-sidebar-foreground",
      )} />
      {!collapsed && <span>{item.name}</span>}
    </NavLink>
  );
}
