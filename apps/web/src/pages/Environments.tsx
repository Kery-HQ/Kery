import React from "react";
import {
  Globe,
  Plus,
  Trash,
  ShieldCheck,
  CaretDown,
  Prohibit,
  SignIn,
  UserCircle,
  Database,
  Key,
  LockKey,
  Info,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import {
  fetchEnvironments, createEnvironment, deleteEnvironment,
  fetchAuth, saveAuth, updateEnvironment,
} from "@/projectApi";

const AUTH_MODES: readonly {
  value: string;
  label: string;
  subtitle: string;
  icon: Icon;
  setupHelp: string;
}[] = [
  {
    value: "none",
    label: "No auth",
    subtitle: "Start on your base URL without logging in",
    icon: Prohibit,
    setupHelp:
      "Pick this when the app under test is public or you do not need a logged-in session. Kery opens the environment URL directly and does not send credentials.",
  },
  {
    value: "ui",
    label: "Form-based (UI login)",
    subtitle: "Playwright fills your login form before each run",
    icon: SignIn,
    setupHelp:
      "Set the login page URL, CSS selectors for username, password, and submit, then enter test credentials. Kery navigates to the login URL, fills the fields, submits, and continues the run in that session.",
  },
  {
    value: "clerk",
    label: "Clerk",
    subtitle: "Session token via Clerk Backend API",
    icon: UserCircle,
    setupHelp:
      "Enter your Clerk secret key, Backend API base URL (e.g. https://api.clerk.com), and a test user email and password. Kery obtains a token from Clerk so the browser runs as that user.",
  },
  {
    value: "supabase",
    label: "Supabase",
    subtitle: "Sign in with Supabase Auth and use the JWT",
    icon: Database,
    setupHelp:
      "Provide your project URL, anon (or service) key, and a test user email and password. Kery signs in via Supabase Auth and attaches the returned JWT for the session.",
  },
  {
    value: "apiToken",
    label: "API token (custom)",
    subtitle: "Bring your own JSON config for headers or bearer tokens",
    icon: Key,
    setupHelp:
      "Use the JSON below to describe how Kery should obtain or send a static API token or custom headers. Shape the config to match what your backend expects for authenticated requests.",
  },
  {
    value: "oauthToken",
    label: "OAuth token (custom)",
    subtitle: "Client credentials or other OAuth flows in JSON",
    icon: LockKey,
    setupHelp:
      "Paste a JSON config that defines token URL, client credentials, scopes, and how to read the access token. Kery uses it to fetch a fresh bearer token before runs when your API requires OAuth.",
  },
];

function AuthModeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [contentWidth, setContentWidth] = React.useState<number>();
  React.useLayoutEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const update = () => setContentWidth(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const current = AUTH_MODES.find((m) => m.value === value) ?? AUTH_MODES[0];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "relative flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 pr-8 text-left text-[13px] text-foreground transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:border-primary/40",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <CurrentIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{current.label}</span>
          </span>
          <CaretDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        style={contentWidth ? { width: contentWidth } : undefined}
        className="max-h-[min(60vh,320px)] overflow-y-auto p-1"
      >
        {AUTH_MODES.map((m) => {
          const Icon = m.icon;
          return (
            <DropdownMenuItem
              key={m.value}
              onSelect={() => onChange(m.value)}
              className={cn(
                "flex h-auto cursor-pointer items-start gap-2.5 py-2.5",
                value === m.value && "bg-accent/60",
              )}
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-tight">{m.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {m.subtitle}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AuthModeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const current = AUTH_MODES.find((m) => m.value === value) ?? AUTH_MODES[0];
  return (
    <div className="flex w-full items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        <AuthModeSelect value={value} onChange={onChange} />
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0 border-input"
            aria-label={`How to set up ${current.label}`}
          >
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-[min(100vw-2rem,340px)]">
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground">Setup guide</p>
            <p className="text-[12px] leading-relaxed text-foreground">{current.setupHelp}</p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

type UiAuthForm = {
  autoDetectLogin: boolean;
  autoDetectSelectors: boolean;
  loginUrl: string;
  usernameField: string;
  passwordField: string;
  submitButton: string;
  username: string;
  password: string;
};

const DEFAULT_UI_FORM: UiAuthForm = {
  autoDetectLogin: true,
  autoDetectSelectors: true,
  loginUrl: "",
  usernameField: "",
  passwordField: "",
  submitButton: "",
  username: "",
  password: "",
};

type TokenProviderForm = {
  apiUrl: string;
  apiKey: string;
  email: string;
  password: string;
};

const DEFAULT_TOKEN_FORM: TokenProviderForm = {
  apiUrl: "",
  apiKey: "",
  email: "",
  password: "",
};

function uiFormFromConfig(config: Record<string, any>): UiAuthForm {
  const s = config?.selectors ?? {};
  const c = config?.credentials ?? {};
  const hasSelectorOverride = !!(s.usernameField || s.passwordField || s.submitButton);
  return {
    autoDetectLogin: config?.autoDetectLogin ?? !config?.loginUrl,
    autoDetectSelectors: config?.autoDetectSelectors ?? !hasSelectorOverride,
    loginUrl: config?.loginUrl ?? "",
    usernameField: s.usernameField ?? "",
    passwordField: s.passwordField ?? "",
    submitButton: s.submitButton ?? "",
    username: c.username ?? "",
    password: c.password ?? "",
  };
}

function configFromUiForm(f: UiAuthForm): Record<string, any> {
  return {
    autoDetectLogin: f.autoDetectLogin,
    autoDetectSelectors: f.autoDetectSelectors,
    loginUrl: f.autoDetectLogin ? undefined : f.loginUrl.trim() || undefined,
    selectors: {
      usernameField: f.usernameField.trim() || undefined,
      passwordField: f.passwordField.trim() || undefined,
      submitButton: f.submitButton.trim() || undefined,
    },
    credentials: {
      username: f.username.trim() || undefined,
      password: f.password || undefined,
    },
  };
}

function tokenFormFromConfig(config: Record<string, any>): TokenProviderForm {
  const tp = config?.tokenProvider ?? {};
  const creds = tp.credentials ?? {};
  return {
    apiUrl: tp.apiUrl ?? "",
    apiKey: tp.apiKey ?? "",
    email: creds.email ?? "",
    password: creds.password ?? "",
  };
}

function configFromTokenForm(f: TokenProviderForm, providerType: string): Record<string, any> {
  return {
    tokenProvider: {
      type: providerType,
      apiUrl: f.apiUrl.trim(),
      apiKey: f.apiKey.trim(),
      credentials: {
        email: f.email.trim(),
        password: f.password,
      },
    },
  };
}

type Env = { id: string; name: string; base_url: string; is_default: boolean };

export const Environments: React.FC = () => {
  const { currentProjectId } = useProject();

  const [envs, setEnvs] = React.useState<Env[]>([]);
  const [expandedEnvId, setExpandedEnvId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Env edit state
  const [editName, setEditName] = React.useState("");
  const [editUrl, setEditUrl] = React.useState("");
  const [savingEnv, setSavingEnv] = React.useState(false);
  const [envStatus, setEnvStatus] = React.useState("");

  // Create form
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = React.useState<Env | null>(null);

  // Auth state
  const [authMode, setAuthMode] = React.useState<string>("none");
  const [authJson, setAuthJson] = React.useState("{}");
  const [uiForm, setUiForm] = React.useState<UiAuthForm>(DEFAULT_UI_FORM);
  const [tokenForm, setTokenForm] = React.useState<TokenProviderForm>(DEFAULT_TOKEN_FORM);
  const [authSaving, setAuthSaving] = React.useState(false);
  const [authStatus, setAuthStatus] = React.useState("");

  React.useEffect(() => {
    if (!currentProjectId) return;
    loadEnvs();
  }, [currentProjectId]);

  async function loadEnvs() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchEnvironments(currentProjectId).catch(() => ({ environments: [] }));
    const list: Env[] = res.environments || [];
    setEnvs(list);
    setLoading(false);
  }

  async function expandEnv(env: Env) {
    if (expandedEnvId === env.id) {
      setExpandedEnvId(null);
      return;
    }
    setExpandedEnvId(env.id);
    setEditName(env.name);
    setEditUrl(env.base_url);
    setEnvStatus("");
    setAuthStatus("");
    if (!currentProjectId) return;
    try {
      const { auth } = await fetchAuth(currentProjectId, env.id);
      if (auth) {
        const cfg = auth.config_json || {};
        // Map tokenProvider mode to clerk/supabase UI mode
        if (auth.mode === "tokenProvider" && cfg.tokenProvider?.type) {
          setAuthMode(cfg.tokenProvider.type); // "clerk" or "supabase"
        } else {
          setAuthMode(auth.mode || "none");
        }
        setAuthJson(JSON.stringify(cfg, null, 2));
        setUiForm(uiFormFromConfig(cfg));
        setTokenForm(tokenFormFromConfig(cfg));
      } else {
        setAuthMode("none");
        setAuthJson("{}");
        setUiForm(DEFAULT_UI_FORM);
        setTokenForm(DEFAULT_TOKEN_FORM);
      }
    } catch {
      setAuthMode("none");
      setAuthJson("{}");
      setUiForm(DEFAULT_UI_FORM);
      setTokenForm(DEFAULT_TOKEN_FORM);
    }
  }

  async function handleCreate() {
    if (!currentProjectId || !newName.trim() || !newUrl.trim()) return;
    setCreating(true);
    try {
      const res = await createEnvironment(currentProjectId, {
        name: newName.trim(),
        baseUrl: newUrl.trim(),
        isDefault: envs.length === 0,
      });
      setEnvs((prev) => [res.environment, ...prev]);
      setExpandedEnvId(res.environment.id);
      setEditName(res.environment.name);
      setEditUrl(res.environment.base_url);
      setEnvStatus("");
      setAuthMode("none");
      setAuthJson("{}");
      setUiForm(DEFAULT_UI_FORM);
      setTokenForm(DEFAULT_TOKEN_FORM);
      setAuthStatus("");
      setCreateOpen(false);
      setNewName("");
      setNewUrl("");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(env: Env) {
    if (!currentProjectId) return;
    await deleteEnvironment(currentProjectId, env.id);
    setEnvs((prev) => prev.filter((e) => e.id !== env.id));
    if (expandedEnvId === env.id) setExpandedEnvId(null);
    setDeleteTarget(null);
  }

  async function handleSaveEnv() {
    if (!currentProjectId || !expandedEnvId) return;
    const name = editName.trim();
    const url = editUrl.trim();
    if (!name || !url) return;
    setSavingEnv(true);
    setEnvStatus("");
    try {
      const res = await updateEnvironment(currentProjectId, expandedEnvId, {
        name,
        baseUrl: url,
      });
      const updated: Env = res.environment;
      setEnvs((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      setEnvStatus("Saved.");
    } catch {
      setEnvStatus("Save failed.");
    } finally {
      setSavingEnv(false);
    }
  }

  async function handleSaveAuth() {
    if (!currentProjectId || !expandedEnvId) return;
    setAuthSaving(true);
    setAuthStatus("");
    try {
      let config: Record<string, any>;
      let mode = authMode;
      if (authMode === "none") {
        config = {};
      } else if (authMode === "ui") {
        config = configFromUiForm(uiForm);
      } else if (authMode === "clerk" || authMode === "supabase") {
        config = configFromTokenForm(tokenForm, authMode);
        mode = "tokenProvider";
      } else {
        config = JSON.parse(authJson);
      }
      await saveAuth(currentProjectId, expandedEnvId, mode, config);
      setAuthStatus("Saved.");
    } catch (e: any) {
      setAuthStatus(e?.message?.includes("Save failed") ? "Save failed." : "Invalid JSON.");
    } finally {
      setAuthSaving(false);
    }
  }

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Globe className="h-4 w-4" />} title="Environments" />
        <EmptyState
          icon={<Globe className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to manage environments."
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Globe className="h-4 w-4" />} title="Environments">
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Environment
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Environment</DialogTitle>
              <DialogDescription>Add a target environment for running tests.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Name</label>
                <Input
                  placeholder="e.g. Staging"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Base URL</label>
                <Input
                  placeholder="https://staging.example.com"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  className="font-mono"
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                size="sm"
                onClick={handleCreate}
                loading={creating}
                disabled={!newName.trim() || !newUrl.trim()}
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Environment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">"{deleteTarget?.name}"</span>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="p-6 animate-fade-in">
        <div className="max-w-2xl mx-auto space-y-3">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : envs.length === 0 ? (
            <EmptyState
              icon={<Globe className="h-8 w-8" />}
              title="No environments"
              description="Add your first environment to start running tests."
              className="py-16"
            />
          ) : (
            envs.map((env) => {
              const isExpanded = expandedEnvId === env.id;
              return (
                <Card key={env.id} className="overflow-hidden">
                  {/* Card header row */}
                  <button
                    onClick={() => expandEnv(env)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                      isExpanded ? "bg-accent/50" : "hover:bg-accent/30",
                    )}
                  >
                    <CaretDown
                      className={cn(
                        "h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0 transition-transform duration-150",
                        isExpanded ? "rotate-0" : "-rotate-90",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-foreground truncate">
                          {env.name}
                        </span>
                        {env.is_default && (
                          <Badge variant="default" className="text-[9px] px-1.5 py-0">default</Badge>
                        )}
                      </div>
                      <p className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">
                        {env.base_url}
                      </p>
                    </div>
                    <div
                      className="flex-shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(env)}
                        className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </button>

                  {/* Expanded edit form */}
                  {isExpanded && (
                    <div className="border-t border-border px-4 py-4 space-y-5 animate-fade-in">
                      {/* Environment details */}
                      <section className="space-y-3">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                          Environment
                        </p>
                        <div>
                          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Name</label>
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Base URL</label>
                          <Input
                            value={editUrl}
                            onChange={(e) => setEditUrl(e.target.value)}
                            className="font-mono"
                          />
                        </div>
                        <div className="flex items-center gap-3 pt-1">
                          <Button
                            size="sm"
                            onClick={handleSaveEnv}
                            loading={savingEnv}
                            disabled={!editName.trim() || !editUrl.trim()}
                          >
                            Save environment
                          </Button>
                          {envStatus && (
                            <span className={cn(
                              "text-[12px]",
                              envStatus === "Saved." ? "text-status-pass" : "text-destructive",
                            )}>
                              {envStatus}
                            </span>
                          )}
                        </div>
                      </section>

                      <Separator />

                      {/* Auth configuration */}
                      <section className="space-y-4">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                            Authentication
                          </p>
                        </div>

                        <div className="w-full min-w-0">
                          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Mode</label>
                          <AuthModeField value={authMode} onChange={setAuthMode} />
                        </div>

                        {authMode === "none" && (
                          <p className="text-[12px] text-muted-foreground">
                            No authentication configured. Runs will start directly on the base URL.
                          </p>
                        )}

                        {authMode === "ui" && (
                          <div className="space-y-3">
                            <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[12px] font-medium text-foreground">Auto-detect login page</p>
                                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                                    Start from the environment base URL and let Kery find the login route.
                                  </p>
                                </div>
                                <Switch
                                  checked={uiForm.autoDetectLogin}
                                  onCheckedChange={(checked) => setUiForm((f) => ({ ...f, autoDetectLogin: checked }))}
                                  aria-label="Auto-detect login page"
                                />
                              </div>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[12px] font-medium text-foreground">Auto-detect selectors</p>
                                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                                    Kery tries to detect username, password, and submit controls automatically.
                                  </p>
                                </div>
                                <Switch
                                  checked={uiForm.autoDetectSelectors}
                                  onCheckedChange={(checked) => setUiForm((f) => ({ ...f, autoDetectSelectors: checked }))}
                                  aria-label="Auto-detect selectors"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Login URL</label>
                              <Input
                                type="url"
                                placeholder="https://your-app.example.com/login"
                                value={uiForm.loginUrl}
                                onChange={(e) => setUiForm((f) => ({ ...f, loginUrl: e.target.value }))}
                                className="font-mono text-[12px]"
                                disabled={uiForm.autoDetectLogin}
                              />
                              {uiForm.autoDetectLogin && (
                                <p className="mt-1 text-[10px] text-muted-foreground/70">
                                  Optional when auto-detect is enabled.
                                </p>
                              )}
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Username field selector</label>
                                <Input
                                  placeholder="#email"
                                  value={uiForm.usernameField}
                                  onChange={(e) => setUiForm((f) => ({ ...f, usernameField: e.target.value }))}
                                  className="font-mono text-[12px]"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Password field selector</label>
                                <Input
                                  placeholder="#password"
                                  value={uiForm.passwordField}
                                  onChange={(e) => setUiForm((f) => ({ ...f, passwordField: e.target.value }))}
                                  className="font-mono text-[12px]"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Submit selector</label>
                                <Input
                                  placeholder="button[type=submit]"
                                  value={uiForm.submitButton}
                                  onChange={(e) => setUiForm((f) => ({ ...f, submitButton: e.target.value }))}
                                  className="font-mono text-[12px]"
                                />
                              </div>
                            </div>
                            <p className="text-[10px] text-muted-foreground/70">
                              Selector fields are optional overrides; leave blank to rely on auto-detection.
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Username</label>
                                <Input
                                  autoComplete="off"
                                  placeholder="user@example.com"
                                  value={uiForm.username}
                                  onChange={(e) => setUiForm((f) => ({ ...f, username: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Password</label>
                                <Input
                                  type="password"
                                  autoComplete="off"
                                  placeholder="password"
                                  value={uiForm.password}
                                  onChange={(e) => setUiForm((f) => ({ ...f, password: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {authMode === "clerk" && (
                          <div className="space-y-3">
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Clerk Secret Key</label>
                              <Input
                                type="password"
                                autoComplete="off"
                                placeholder="sk_test_..."
                                value={tokenForm.apiKey}
                                onChange={(e) => setTokenForm((f) => ({ ...f, apiKey: e.target.value }))}
                                className="font-mono text-[12px]"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Clerk API URL</label>
                              <Input
                                type="url"
                                placeholder="https://api.clerk.com"
                                value={tokenForm.apiUrl}
                                onChange={(e) => setTokenForm((f) => ({ ...f, apiUrl: e.target.value }))}
                                className="font-mono text-[12px]"
                              />
                              <p className="text-[10px] text-muted-foreground/60 mt-1">Clerk Backend API base URL</p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Test user email</label>
                                <Input
                                  autoComplete="off"
                                  placeholder="test@example.com"
                                  value={tokenForm.email}
                                  onChange={(e) => setTokenForm((f) => ({ ...f, email: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Test user password</label>
                                <Input
                                  type="password"
                                  autoComplete="off"
                                  placeholder="password"
                                  value={tokenForm.password}
                                  onChange={(e) => setTokenForm((f) => ({ ...f, password: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {authMode === "supabase" && (
                          <div className="space-y-3">
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Supabase Project URL</label>
                              <Input
                                type="url"
                                placeholder="https://your-ref.supabase.co"
                                value={tokenForm.apiUrl}
                                onChange={(e) => setTokenForm((f) => ({ ...f, apiUrl: e.target.value }))}
                                className="font-mono text-[12px]"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Supabase Anon Key</label>
                              <Input
                                type="password"
                                autoComplete="off"
                                placeholder="eyJhbGciOi..."
                                value={tokenForm.apiKey}
                                onChange={(e) => setTokenForm((f) => ({ ...f, apiKey: e.target.value }))}
                                className="font-mono text-[12px]"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Test user email</label>
                                <Input
                                  autoComplete="off"
                                  placeholder="test@example.com"
                                  value={tokenForm.email}
                                  onChange={(e) => setTokenForm((f) => ({ ...f, email: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Test user password</label>
                                <Input
                                  type="password"
                                  autoComplete="off"
                                  placeholder="password"
                                  value={tokenForm.password}
                                  onChange={(e) => setTokenForm((f) => ({ ...f, password: e.target.value }))}
                                  className="text-[12px]"
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {(authMode === "apiToken" || authMode === "oauthToken") && (
                          <div>
                            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Config (JSON)</label>
                            <Textarea
                              value={authJson}
                              onChange={(e) => setAuthJson(e.target.value)}
                              rows={10}
                              className="font-mono text-[12px] min-h-[180px] resize-y"
                            />
                          </div>
                        )}

                        <div className="flex items-center gap-3 pt-1">
                          <Button
                            size="sm"
                            onClick={handleSaveAuth}
                            loading={authSaving}
                          >
                            {authMode === "none" ? "Save (no auth)" : "Save auth config"}
                          </Button>
                          {authStatus && (
                            <span className={cn(
                              "text-[12px]",
                              authStatus === "Saved." ? "text-status-pass" : "text-destructive",
                            )}>
                              {authStatus}
                            </span>
                          )}
                        </div>
                      </section>
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
