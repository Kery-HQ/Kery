import React from "react";
import {
  Globe, Plus, Trash2, ShieldCheck, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
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

const AUTH_MODES = [
  { value: "none", label: "No auth" },
  { value: "ui", label: "Form-based (UI login)" },
  { value: "apiToken", label: "API token" },
  { value: "oauthToken", label: "OAuth token" },
] as const;

type UiAuthForm = {
  loginUrl: string;
  usernameField: string;
  passwordField: string;
  submitButton: string;
  username: string;
  password: string;
};

const DEFAULT_UI_FORM: UiAuthForm = {
  loginUrl: "",
  usernameField: "#email",
  passwordField: "#password",
  submitButton: "button[type=submit]",
  username: "",
  password: "",
};

function uiFormFromConfig(config: Record<string, any>): UiAuthForm {
  const s = config?.selectors ?? {};
  const c = config?.credentials ?? {};
  return {
    loginUrl: config?.loginUrl ?? "",
    usernameField: s.usernameField ?? DEFAULT_UI_FORM.usernameField,
    passwordField: s.passwordField ?? DEFAULT_UI_FORM.passwordField,
    submitButton: s.submitButton ?? DEFAULT_UI_FORM.submitButton,
    username: c.username ?? "",
    password: c.password ?? "",
  };
}

function configFromUiForm(f: UiAuthForm): Record<string, any> {
  return {
    loginUrl: f.loginUrl.trim() || undefined,
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
        setAuthMode(auth.mode || "none");
        const cfg = auth.config_json || {};
        setAuthJson(JSON.stringify(cfg, null, 2));
        setUiForm(uiFormFromConfig(cfg));
      } else {
        setAuthMode("none");
        setAuthJson("{}");
        setUiForm(DEFAULT_UI_FORM);
      }
    } catch {
      setAuthMode("none");
      setAuthJson("{}");
      setUiForm(DEFAULT_UI_FORM);
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
      const config =
        authMode === "none"
          ? {}
          : authMode === "ui"
            ? configFromUiForm(uiForm)
            : JSON.parse(authJson);
      await saveAuth(currentProjectId, expandedEnvId, authMode, config);
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
                    <ChevronDown
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
                        <Trash2 className="h-3.5 w-3.5" />
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

                        <div>
                          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Mode</label>
                          <Select
                            value={authMode}
                            onChange={(e) => setAuthMode(e.target.value)}
                            className="w-[220px]"
                          >
                            {AUTH_MODES.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </Select>
                        </div>

                        {authMode === "none" && (
                          <p className="text-[12px] text-muted-foreground">
                            No authentication configured. Runs will start directly on the base URL.
                          </p>
                        )}

                        {authMode === "ui" && (
                          <div className="space-y-3">
                            <div>
                              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Login URL</label>
                              <Input
                                type="url"
                                placeholder="https://your-app.example.com/login"
                                value={uiForm.loginUrl}
                                onChange={(e) => setUiForm((f) => ({ ...f, loginUrl: e.target.value }))}
                                className="font-mono text-[12px]"
                              />
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
