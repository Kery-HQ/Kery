import React from "react";
import {
  Globe, Plus, Trash2, ShieldCheck, ChevronRight, Check, X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select } from "../components/ui/select";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import {
  fetchEnvironments, createEnvironment, deleteEnvironment,
  fetchAuth, saveAuth, updateEnvironment,
} from "../projectApi";

const AUTH_MODES = [
  { value: "none", label: "No auth" },
  { value: "ui", label: "Form-based (UI)" },
  { value: "apiToken", label: "API token" },
  { value: "oauthToken", label: "OAuth token" },
] as const;

const AUTH_PLACEHOLDER = `{
  "loginUrl": "https://your-app.example.com/login",
  "selectors": {
    "usernameField": "#email",
    "passwordField": "#password",
    "submitButton": "button[type=submit]"
  },
  "credentials": {
    "username": "user@example.com",
    "password": "password123"
  }
}`;

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
  const [selectedEnv, setSelectedEnv] = React.useState<Env | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Env edit state
  const [editName, setEditName] = React.useState("");
  const [editUrl, setEditUrl] = React.useState("");
  const [savingEnv, setSavingEnv] = React.useState(false);
  const [envStatus, setEnvStatus] = React.useState("");

  // Create form
  const [showCreate, setShowCreate] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Auth state
  const [authMode, setAuthMode] = React.useState<string>("ui");
  const [authJson, setAuthJson] = React.useState(AUTH_PLACEHOLDER);
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
    if (list.length > 0 && !selectedEnv) selectEnv(list[0]);
    setLoading(false);
  }

  async function selectEnv(env: Env) {
    setSelectedEnv(env);
    setEditName(env.name);
    setEditUrl(env.base_url);
    setEnvStatus("");
    setAuthStatus("");
    if (!currentProjectId) return;
    try {
      const { auth } = await fetchAuth(currentProjectId, env.id);
      if (auth) {
        setAuthMode(auth.mode || "ui");
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
      selectEnv(res.environment);
      setShowCreate(false);
      setNewName("");
      setNewUrl("");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(env: Env) {
    if (!currentProjectId || !confirm(`Delete "${env.name}"?`)) return;
    await deleteEnvironment(currentProjectId, env.id);
    setEnvs((prev) => prev.filter((e) => e.id !== env.id));
    if (selectedEnv?.id === env.id) setSelectedEnv(null);
  }

  async function handleSaveEnv() {
    if (!currentProjectId || !selectedEnv) return;
    const name = editName.trim();
    const url = editUrl.trim();
    if (!name || !url) return;
    setSavingEnv(true);
    setEnvStatus("");
    try {
      const res = await updateEnvironment(currentProjectId, selectedEnv.id, {
        name,
        baseUrl: url,
      });
      const updated: Env = res.environment;
      setEnvs((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      setSelectedEnv(updated);
      setEnvStatus("Saved.");
    } catch {
      setEnvStatus("Save failed — check server.");
    } finally {
      setSavingEnv(false);
    }
  }

  async function handleSaveAuth() {
    if (!currentProjectId || !selectedEnv) return;
    setAuthSaving(true);
    setAuthStatus("");
    try {
      const config =
        authMode === "none"
          ? {}
          : authMode === "ui"
            ? configFromUiForm(uiForm)
            : JSON.parse(authJson);
      await saveAuth(currentProjectId, selectedEnv.id, authMode, config);
      setAuthStatus("Saved.");
    } catch (e: any) {
      setAuthStatus(e?.message?.includes("Save failed") ? "Save failed — check server." : "Invalid JSON.");
    } finally {
      setAuthSaving(false);
    }
  }

  if (!currentProjectId) {
    return (
      <EmptyState message="Select a project to manage environments." />
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Environments</span>
          {envs.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground ml-1">{envs.length}</span>
          )}
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add environment
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: env list */}
        <div className="w-72 flex-shrink-0 border-r border-border flex flex-col overflow-y-auto">

          {showCreate && (
            <Card className="m-4">
              <CardHeader className="pb-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">New environment</p>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <div>
                  <label htmlFor="env-name" className="text-[11px] font-medium text-foreground/80 mb-1 block">Name</label>
                  <Input
                    id="env-name"
                    placeholder="e.g. Staging"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                    className="h-8"
                  />
                </div>
                <div>
                  <label htmlFor="env-url" className="text-[11px] font-medium text-foreground/80 mb-1 block">Base URL</label>
                  <Input
                    id="env-url"
                    placeholder="https://staging.example.com"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                    className="h-8"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim() || !newUrl.trim()} className="gap-1.5">
                    <Check className="h-3 w-3" />
                    {creating ? "Adding…" : "Add"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setNewName(""); setNewUrl(""); }} className="gap-1.5">
                    <X className="h-3 w-3" /> Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {loading ? (
            <div className="p-4 space-y-2">
              {[1,2].map(i => <div key={i} className="h-12 rounded-lg border border-border animate-pulse" />)}
            </div>
          ) : envs.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 py-16 text-center px-6">
              <Globe className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-[14px] font-medium text-foreground mb-1">No environments yet</p>
              <p className="text-[12px] text-muted-foreground">Add your first environment to start running tests. Include staging, production, or local URLs.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {envs.map((env) => (
                <div
                  key={env.id}
                  onClick={() => selectEnv(env)}
                  className={cn(
                    "group w-full flex items-center gap-3 px-4 py-3.5 text-left transition-all cursor-pointer",
                    selectedEnv?.id === env.id ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <Globe className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-foreground truncate">{env.name}</p>
                      {env.is_default && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-primary/15 text-primary shrink-0">default</span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-muted-foreground truncate">{env.base_url}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(env); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-destructive flex-shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {selectedEnv?.id === env.id && (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: auth config */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {!selectedEnv ? (
            <div className="flex flex-col items-center justify-center h-full py-20 text-center max-w-sm mx-auto">
              <Globe className="h-12 w-12 text-muted-foreground/20 mb-4" />
              <p className="text-[14px] font-medium text-foreground mb-1">Select an environment</p>
              <p className="text-[12px] text-muted-foreground">Choose an environment from the list to configure authentication and run tests against it.</p>
            </div>
          ) : (
            <div className="animate-fade-in space-y-6">
              {/* Env info */}
              <Card>
                <CardHeader className="pb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Environment</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-3">
                    <div>
                      <label htmlFor="env-edit-name" className="text-[11px] font-medium text-foreground/80 mb-1 block">
                        Name
                      </label>
                      <Input
                        id="env-edit-name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <label htmlFor="env-edit-url" className="text-[11px] font-medium text-foreground/80 mb-1 block">
                        Base URL
                      </label>
                      <Input
                        id="env-edit-url"
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="h-8 font-mono"
                      />
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                      <Button
                        size="sm"
                        onClick={handleSaveEnv}
                        disabled={savingEnv || !editName.trim() || !editUrl.trim()}
                        className="gap-1.5"
                      >
                        {savingEnv ? "Saving…" : "Save environment"}
                      </Button>
                      {envStatus && (
                        <span
                          className={cn(
                            "text-[12px]",
                            envStatus.startsWith("Saved")
                              ? "text-emerald-600 dark:text-emerald-500"
                              : "text-muted-foreground",
                          )}
                        >
                          {envStatus}
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Auth config */}
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                      Authentication
                    </p>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <label htmlFor="auth-mode" className="text-[12px] font-medium text-foreground/80">Method</label>
                    <Select
                      id="auth-mode"
                      value={authMode}
                      onChange={(e) => setAuthMode(e.target.value)}
                      className="w-[180px] h-8 text-[12px]"
                    >
                      {AUTH_MODES.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </Select>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-4">
                  {authMode === "none" ? (
                    <p className="text-[12px] text-muted-foreground">
                      This environment does not require authentication. Runs will start directly on the base URL.
                    </p>
                  ) : authMode === "ui" ? (
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="ui-login-url" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                          Login URL
                        </label>
                        <Input
                          id="ui-login-url"
                          type="url"
                          placeholder="https://your-app.example.com/login"
                          value={uiForm.loginUrl}
                          onChange={(e) => setUiForm((f) => ({ ...f, loginUrl: e.target.value }))}
                          className="h-8 font-mono text-[12px]"
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label htmlFor="ui-username-sel" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                            Username field selector
                          </label>
                          <Input
                            id="ui-username-sel"
                            placeholder="#email"
                            value={uiForm.usernameField}
                            onChange={(e) => setUiForm((f) => ({ ...f, usernameField: e.target.value }))}
                            className="h-8 font-mono text-[12px]"
                          />
                        </div>
                        <div>
                          <label htmlFor="ui-password-sel" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                            Password field selector
                          </label>
                          <Input
                            id="ui-password-sel"
                            placeholder="#password"
                            value={uiForm.passwordField}
                            onChange={(e) => setUiForm((f) => ({ ...f, passwordField: e.target.value }))}
                            className="h-8 font-mono text-[12px]"
                          />
                        </div>
                        <div>
                          <label htmlFor="ui-submit-sel" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                            Submit button selector
                          </label>
                          <Input
                            id="ui-submit-sel"
                            placeholder="button[type=submit]"
                            value={uiForm.submitButton}
                            onChange={(e) => setUiForm((f) => ({ ...f, submitButton: e.target.value }))}
                            className="h-8 font-mono text-[12px]"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="ui-username" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                            Username
                          </label>
                          <Input
                            id="ui-username"
                            type="text"
                            autoComplete="off"
                            placeholder="user@example.com"
                            value={uiForm.username}
                            onChange={(e) => setUiForm((f) => ({ ...f, username: e.target.value }))}
                            className="h-8 text-[12px]"
                          />
                        </div>
                        <div>
                          <label htmlFor="ui-password" className="text-[12px] font-medium text-foreground/80 mb-1 block">
                            Password
                          </label>
                          <Input
                            id="ui-password"
                            type="password"
                            autoComplete="off"
                            placeholder="••••••••"
                            value={uiForm.password}
                            onChange={(e) => setUiForm((f) => ({ ...f, password: e.target.value }))}
                            className="h-8 text-[12px]"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="auth-json" className="text-[12px] font-medium text-foreground/80 mb-1.5 block">
                        Config (JSON)
                      </label>
                      <Textarea
                        id="auth-json"
                        value={authJson}
                        onChange={(e) => setAuthJson(e.target.value)}
                        rows={12}
                        className="font-mono text-[12px] min-h-[200px] resize-y"
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Button size="sm" onClick={handleSaveAuth} disabled={authSaving} className="gap-1.5">
                      {authSaving ? "Saving…" : authMode === "none" ? "Save (no auth)" : "Save auth config"}
                    </Button>
                    {authStatus && (
                      <span className={cn(
                        "text-[12px]",
                        authStatus.startsWith("Saved") ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground",
                      )}>
                        {authStatus}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col min-h-full">
      <div className="flex items-center gap-2 px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <Globe className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Environments</span>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
