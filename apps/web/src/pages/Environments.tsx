import React from "react";
import { useNavigate } from "react-router-dom";
import {
  Globe,
  Code,
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
  Play,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import {
  fetchEnvironments, createEnvironment, deleteEnvironment,
  fetchAuth, saveAuth, updateEnvironment, testEnvironmentConnection, runAuthTest, runConnectionVerification, fetchRun,
  type ConnectionAuditResult,
  type ConnectionAuditStatus,
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
      "Enter test credentials. Kery navigates to your login page, fills the fields, and continues the run in that session. Use Advanced settings to override the login URL and field selectors.",
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

function auditVariant(status: ConnectionAuditStatus): "success" | "warning" | "destructive" {
  if (status === "ok") return "success";
  if (status === "warning") return "warning";
  return "destructive";
}

function formatProbeError(error: Record<string, unknown> | undefined): string | null {
  if (!error) return null;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return [code, message].filter(Boolean).join(": ") || null;
}

function buildTroubleshootingPrompt(
  audit: ConnectionAuditResult,
  projectId: string | null,
  environmentId: string | null,
): string {
  const probeError = formatProbeError(audit.probe?.error);
  const status = typeof audit.probe?.statusCode === "number" ? `HTTP ${audit.probe.statusCode}` : null;
  const observed = [
    `Kery summary: ${audit.summary}`,
    `Target URL: ${audit.targetUrl}`,
    `Runtime: ${audit.runtime}`,
    audit.probe?.url ? `Probe URL: ${audit.probe.url}` : null,
    audit.probe?.hostHeader ? `Host header: ${audit.probe.hostHeader}` : null,
    status,
    probeError ? `Probe error: ${probeError}` : null,
  ].filter(Boolean).join("\n");

  return [
    "Diagnose why Kery cannot reach this app.",
    projectId && environmentId
      ? `If Kery MCP is available, call kery_test_connection with projectId="${projectId}" and environmentId="${environmentId}".`
      : "If Kery MCP is available, list projects and run kery_test_connection for this environment.",
    "If MCP asks for projectDir, ask me for the local app project directory and rerun with projectDir.",
    "Also inspect how the app server is started, what host/port it listens on, and whether the configured URL is blocked by app or auth-provider origin settings.",
    "Show what you checked and the smallest exact change needed.",
    "",
    observed,
  ].join("\n");
}

type ConnectionTestPhase = "idle" | "checking" | "starting-browser" | "running-browser" | "passed" | "failed";

type ConnectionTestRun = {
  runId: string;
  status: "queued" | "running" | "passed" | "failed" | string;
  summary?: string | null;
};

function TestConnectionDialog({
  open,
  onOpenChange,
  phase,
  audit,
  error,
  run,
  authMode,
  projectId,
  environmentId,
  onRun,
  onOpenRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: ConnectionTestPhase;
  audit: ConnectionAuditResult | null;
  error: string;
  run: ConnectionTestRun | null;
  authMode: string;
  projectId: string | null;
  environmentId: string | null;
  onRun: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const busy = phase === "checking" || phase === "starting-browser" || phase === "running-browser";
  const isAuth = authMode !== "none";
  const browserFailed = run?.status === "failed" || (phase === "failed" && audit?.status !== "failed");
  const browserPassed = run?.status === "passed" || phase === "passed";
  const browserStarting = phase === "starting-browser";
  const browserChecking = phase === "running-browser";

  React.useEffect(() => {
    setCopied(false);
  }, [audit?.checkedAt, open]);

  const badge = audit ? (
    <Badge variant={auditVariant(audit.status)} dot className="uppercase">
      {audit.status}
    </Badge>
  ) : (
    <Badge variant="destructive" dot className="uppercase">failed</Badge>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Test connection</DialogTitle>
          <DialogDescription>
            First Kery checks that it can reach your app. If that works, Kery creates a browser run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {phase === "idle" && (
            <div className="rounded-md border border-border bg-surface-1 p-3">
              <p className="text-[13px] text-foreground">Credential saved</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Run this check now to make sure Kery can use it.
              </p>
            </div>
          )}

          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-medium text-foreground">Can Kery reach your app?</p>
                <p className={cn(
                  "mt-1 text-[12px] leading-relaxed",
                  audit?.status === "failed" || (!audit && error) ? "text-destructive" : "text-muted-foreground",
                )}>
                  {phase === "checking"
                    ? "Checking..."
                    : audit?.summary || error || "Not checked yet."}
                </p>
              </div>
              {phase === "checking" ? (
                <Badge variant="running" dot>checking</Badge>
              ) : audit || error ? badge : (
                <Badge variant="neutral">pending</Badge>
              )}
            </div>
            {audit?.recommendations[0] && audit.status !== "ok" && (
              <p className="mt-2 text-[12px] text-muted-foreground">{audit.recommendations[0]}</p>
            )}
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-medium text-foreground">
                  {isAuth ? "Can Kery sign in?" : "Can Kery open it in a browser?"}
                </p>
                <p className={cn(
                  "mt-1 text-[12px] leading-relaxed",
                  browserFailed ? "text-destructive" : "text-muted-foreground",
                )}>
                  {browserStarting
                    ? "Starting..."
                    : browserChecking
                    ? "Checking..."
                    : browserPassed
                      ? "OK"
                      : browserFailed
                        ? run?.summary || error || "Failed"
                      : audit?.status === "failed"
                        ? "Skipped until Kery can reach your app."
                        : "Waiting for the reachability check."}
                </p>
              </div>
              {browserStarting ? (
                <Badge variant="running" dot>starting</Badge>
              ) : browserChecking ? (
                <Badge variant="running" dot>checking</Badge>
              ) : browserPassed ? (
                <Badge variant="success" dot>OK</Badge>
              ) : browserFailed ? (
                <Badge variant="destructive" dot>failed</Badge>
              ) : (
                <Badge variant="neutral">pending</Badge>
              )}
            </div>
            {browserFailed && run && (
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => onOpenRun(run.runId)}>
                  See run
                </Button>
              </div>
            )}
            {browserFailed && error && !run && (
              <p className="mt-2 text-[12px] text-destructive">{error}</p>
            )}
          </div>

          {audit?.status === "failed" && (
            <div className="rounded-md border border-border p-3">
              <p className="text-[12px] text-muted-foreground">
                Need help fixing this? Copy a diagnostic prompt for your AI assistant or support workflow.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-[11px]"
                onClick={async () => {
                  await navigator.clipboard.writeText(buildTroubleshootingPrompt(audit, projectId, environmentId)).catch(() => {});
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy fix prompt"}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          {browserFailed && run ? (
            <Button onClick={() => onOpenRun(run.runId)}>See run</Button>
          ) : (
            <Button onClick={onRun} loading={busy} disabled={busy}>
              {busy ? "Checking" : phase === "idle" ? "Run check" : "Retry"}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

function normalizeFrontendUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;

  const hostPart = trimmed.split(/[/?#]/, 1)[0]?.replace(/^\[/, "").replace(/\]$/, "") ?? "";
  const hostname = hostPart.split(":")[0]?.toLowerCase() ?? "";
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

function uiFormFromConfig(config: Record<string, any>): UiAuthForm {
  const s = config?.selectors ?? {};
  const c = config?.credentials ?? {};
  return {
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
    autoDetectLogin: true,
    autoDetectSelectors: true,
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

// ── UI form fields shared between onboarding and detail view ──────────────────

function UiAuthFields({
  form,
  onChange,
}: {
  form: UiAuthForm;
  onChange: (f: UiAuthForm) => void;
}) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Username</label>
          <Input
            autoComplete="off"
            placeholder="user@example.com"
            value={form.username}
            onChange={(e) => onChange({ ...form, username: e.target.value })}
            className="text-[12px]"
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Password</label>
          <Input
            type="password"
            autoComplete="off"
            placeholder="password"
            value={form.password}
            onChange={(e) => onChange({ ...form, password: e.target.value })}
            className="text-[12px]"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <CaretDown className={cn("h-3 w-3 transition-transform", showAdvanced && "rotate-180")} />
        Advanced settings
      </button>

      {showAdvanced && (
        <div className="space-y-3 pl-4 border-l border-border">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Login URL</label>
            <Input
              type="url"
              placeholder="https://your-app.example.com/login"
              value={form.loginUrl}
              onChange={(e) => onChange({ ...form, loginUrl: e.target.value })}
              className="font-mono text-[12px]"
            />
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              Optional. Leave blank to start from the frontend URL.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Username field</label>
              <Input
                placeholder="#email"
                value={form.usernameField}
                onChange={(e) => onChange({ ...form, usernameField: e.target.value })}
                className="font-mono text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Password field</label>
              <Input
                placeholder="#password"
                value={form.passwordField}
                onChange={(e) => onChange({ ...form, passwordField: e.target.value })}
                className="font-mono text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Submit</label>
              <Input
                placeholder="button[type=submit]"
                value={form.submitButton}
                onChange={(e) => onChange({ ...form, submitButton: e.target.value })}
                className="font-mono text-[12px]"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Selector fields are optional — leave blank to rely on auto-detection.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Onboarding (no environments yet) ─────────────────────────────────────────

function CredentialsOnboarding({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [authMode, setAuthMode] = React.useState("none");
  const [uiForm, setUiForm] = React.useState<UiAuthForm>(DEFAULT_UI_FORM);
  const [tokenForm, setTokenForm] = React.useState<TokenProviderForm>(DEFAULT_TOKEN_FORM);
  const [saving, setSaving] = React.useState(false);

  async function handleSubmit() {
    if (!url.trim()) return;
    setSaving(true);
    try {
      const res = await createEnvironment(projectId, {
        name: "default",
        baseUrl: url.trim(),
        isDefault: true,
      });
      const envId = res.environment.id;

      if (authMode !== "none") {
        let config: Record<string, any>;
        let mode = authMode;
        if (authMode === "ui") {
          config = configFromUiForm(uiForm);
        } else if (authMode === "clerk" || authMode === "supabase") {
          config = configFromTokenForm(tokenForm, authMode);
          mode = "tokenProvider";
        } else {
          config = {};
        }
        await saveAuth(projectId, envId, mode, config);
      }

      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 flex items-start justify-center p-8 pt-16 animate-fade-in">
      <div className="w-full max-w-[480px] space-y-6">
        <div className="space-y-1">
          <h2 className="text-[18px] font-semibold text-foreground">Set up your app</h2>
          <p className="text-[13px] text-muted-foreground">
            Connect your frontend so Kery knows where to test.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Frontend URL</label>
            <Input
              type="url"
              placeholder="https://your-app.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              className="font-mono"
              autoFocus
            />
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Login method</label>
            <AuthModeField value={authMode} onChange={setAuthMode} />
          </div>

          {authMode === "ui" && (
            <UiAuthFields form={uiForm} onChange={setUiForm} />
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

          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={!url.trim()}
            className="w-full"
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Env = { id: string; name: string; base_url: string; is_default: boolean };

export const Environments: React.FC = () => {
  const { currentProjectId } = useProject();
  const navigate = useNavigate();

  const [envs, setEnvs] = React.useState<Env[]>([]);
  const [expandedEnvId, setExpandedEnvId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Env edit state
  const [editName, setEditName] = React.useState("");
  const [editUrl, setEditUrl] = React.useState("");

  // Create dialog (alternate credentials)
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

  // Unified footer state
  const [saving, setSaving] = React.useState(false);
  const [saveStatus, setSaveStatus] = React.useState("");
  const [testingConnection, setTestingConnection] = React.useState(false);
  const [connectionAudit, setConnectionAudit] = React.useState<ConnectionAuditResult | null>(null);
  const [connectionError, setConnectionError] = React.useState("");
  const [connectionDialogOpen, setConnectionDialogOpen] = React.useState(false);
  const [connectionPhase, setConnectionPhase] = React.useState<ConnectionTestPhase>("idle");
  const [connectionRun, setConnectionRun] = React.useState<ConnectionTestRun | null>(null);
  const connectionPollToken = React.useRef(0);

  React.useEffect(() => {
    if (!currentProjectId) return;
    loadEnvs();
  }, [currentProjectId]);

  React.useEffect(() => {
    if (!envs.length) return;
    if (expandedEnvId && envs.some((e) => e.id === expandedEnvId)) return;
    void expandEnv(envs[0]);
  }, [envs, expandedEnvId]);

  async function loadEnvs() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchEnvironments(currentProjectId).catch(() => ({ environments: [] }));
    const list: Env[] = res.environments || [];
    setEnvs(list);
    setLoading(false);
  }

  function resetConnectionTest(phase: ConnectionTestPhase = "idle") {
    connectionPollToken.current += 1;
    setConnectionAudit(null);
    setConnectionError("");
    setConnectionRun(null);
    setConnectionPhase(phase);
  }

  async function waitForVerificationRun(runId: string, token: number): Promise<ConnectionTestRun | null> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (connectionPollToken.current !== token) return null;
      const res = await fetchRun(runId);
      const run = res.run ?? res;
      const status = String(run.status ?? "running");
      const nextRun: ConnectionTestRun = {
        runId,
        status,
        summary: run.summary ?? null,
      };
      setConnectionRun(nextRun);
      if (status !== "queued" && status !== "running") return nextRun;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (connectionPollToken.current !== token) return null;
    return { runId, status: "failed", summary: "Timed out waiting for the browser check." };
  }

  async function expandEnv(env: Env) {
    if (expandedEnvId === env.id) return;
    setExpandedEnvId(env.id);
    setEditName(env.name);
    setEditUrl(env.base_url);
    setSaveStatus("");
    setConnectionDialogOpen(false);
    resetConnectionTest();
    if (!currentProjectId) return;
    try {
      const { auth } = await fetchAuth(currentProjectId, env.id);
      if (auth) {
        const cfg = auth.config_json || {};
        if (auth.mode === "tokenProvider" && cfg.tokenProvider?.type) {
          setAuthMode(cfg.tokenProvider.type);
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
    const normalizedUrl = normalizeFrontendUrl(newUrl);
    setNewUrl(normalizedUrl);
    setCreating(true);
    try {
      const res = await createEnvironment(currentProjectId, {
        name: newName.trim(),
        baseUrl: normalizedUrl,
        isDefault: false,
      });
      setEnvs((prev) => [...prev, res.environment]);
      setExpandedEnvId(res.environment.id);
      setEditName(res.environment.name);
      setEditUrl(res.environment.base_url);
      setSaveStatus("");
      resetConnectionTest();
      setAuthMode("none");
      setAuthJson("{}");
      setUiForm(DEFAULT_UI_FORM);
      setTokenForm(DEFAULT_TOKEN_FORM);
      setCreateOpen(false);
      setNewName("");
      setNewUrl("");
      setConnectionDialogOpen(true);
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

  async function persistCurrentCredential(): Promise<Env> {
    if (!currentProjectId || !expandedEnvId) throw new Error("No credential selected.");
    const name = editName.trim();
    const url = normalizeFrontendUrl(editUrl);
    if (!name || !url) throw new Error("Name and frontend URL are required.");
    setEditUrl(url);

    const res = await updateEnvironment(currentProjectId, expandedEnvId, { name, baseUrl: url });
    const updated: Env = res.environment;
    setEnvs((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));

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
    return updated;
  }

  async function handleSave() {
    setSaving(true);
    setSaveStatus("");
    resetConnectionTest();
    try {
      await persistCurrentCredential();
      setSaveStatus("Saved.");
      setConnectionDialogOpen(true);
    } catch (e: any) {
      setSaveStatus("Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!currentProjectId || !expandedEnvId) return;
    setConnectionDialogOpen(true);
    setTestingConnection(true);
    setSaveStatus("");
    resetConnectionTest("checking");
    const pollToken = connectionPollToken.current;
    try {
      const updated = await persistCurrentCredential();
      setSaveStatus("Saved.");
      const res = await testEnvironmentConnection(currentProjectId, expandedEnvId, updated.base_url);
      setConnectionAudit(res.audit);
      if (res.audit.status === "failed") {
        setConnectionPhase("failed");
        return;
      }
      setConnectionPhase("starting-browser");
      const verificationRun = authMode !== "none"
        ? await runAuthTest(currentProjectId, expandedEnvId)
        : await runConnectionVerification(currentProjectId, expandedEnvId);
      setConnectionRun({
        runId: verificationRun.runId,
        status: verificationRun.status,
      });
      setConnectionPhase("running-browser");
      const completedRun = await waitForVerificationRun(verificationRun.runId, pollToken);
      if (!completedRun) return;
      setConnectionPhase(completedRun.status === "passed" ? "passed" : "failed");
    } catch (e: any) {
      setConnectionError(e?.message ?? "Connection check failed.");
      setConnectionPhase("failed");
    } finally {
      setTestingConnection(false);
    }
  }

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Code className="h-4 w-4" />} title="Credentials" />
        <EmptyState
          icon={<Globe className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to manage credentials."
          className="flex-1"
        />
      </div>
    );
  }

  const selectedEnv = envs.find((e) => e.id === expandedEnvId) ?? envs[0] ?? null;

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<Code className="h-4 w-4" />} title="Credentials">
        {envs.length > 0 && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Add alternate credentials
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New credential</DialogTitle>
                <DialogDescription>Add an alternate set of credentials for this project.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Name</label>
                  <Input
                    placeholder="e.g. Admin user"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Frontend URL</label>
                  <Input
                    placeholder="https://your-app.com"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onBlur={() => setNewUrl((url) => normalizeFrontendUrl(url))}
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
        )}
      </PageHeader>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete credential</DialogTitle>
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

      <div className="flex-1 min-h-0 overflow-hidden animate-fade-in">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : envs.length === 0 ? (
          <CredentialsOnboarding
            projectId={currentProjectId}
            onCreated={loadEnvs}
          />
        ) : (
          <div className="flex h-full min-h-0 overflow-hidden">
            {/* ── Left: credential list ───────────────────────────── */}
            <div className="w-[340px] flex-shrink-0 flex flex-col min-h-0 border-r border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0 bg-surface-2 dark:bg-surface-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Credentials
                </span>
                <span className="text-[11px] font-mono text-muted-foreground/60">{envs.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
                {envs.map((env) => {
                  const isSelected = expandedEnvId === env.id;
                  return (
                    <button
                      key={env.id}
                      type="button"
                      onClick={() => expandEnv(env)}
                      className="w-full text-left block"
                    >
                      <div
                        className={cn(
                          "glass-card-flat p-3 transition-all",
                          isSelected && "ring-2 ring-ring/20 border-border bg-accent/25",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-medium text-foreground truncate">{env.name}</span>
                              {env.is_default && (
                                <Badge variant="default" className="text-[9px] px-1.5 py-0">default</Badge>
                              )}
                            </div>
                            <p className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">{env.base_url}</p>
                          </div>
                          <div className="shrink-0 pt-0.5" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteTarget(env)}
                              className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Right: selected credential controls ─────────────── */}
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
              {selectedEnv ? (
                <div className="flex flex-col h-full">
                  <div className="flex-shrink-0 border-b border-border px-5 py-3 bg-surface-2 dark:bg-surface-3">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-foreground leading-snug truncate min-w-0">
                        {selectedEnv.name}
                      </h2>
                      {selectedEnv.is_default && (
                        <Badge variant="default" className="text-[9px] px-1.5 py-0">default</Badge>
                      )}
                    </div>
                    <p className="text-[12px] font-mono text-muted-foreground mt-0.5 truncate">{selectedEnv.base_url}</p>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
                    {/* Credential details */}
                    <section className="space-y-3">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                        Details
                      </p>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Name</label>
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Frontend URL</label>
                        <Input
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          onBlur={() => setEditUrl((url) => normalizeFrontendUrl(url))}
                          className="font-mono"
                        />
                      </div>
                    </section>

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
                          No authentication configured. Runs will start directly on the frontend URL.
                        </p>
                      )}

                      {authMode === "ui" && (
                        <UiAuthFields form={uiForm} onChange={setUiForm} />
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
                              <label className="text-[11px] font-medium text-muted-foreground hover:text-foreground mb-1 block">Test user password</label>
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
                    </section>
                  </div>

                  {/* Sticky footer */}
                  <div className="flex-shrink-0 border-t border-border px-6 py-3 flex items-center gap-3 bg-surface-2 dark:bg-surface-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSave}
                      loading={saving}
                      disabled={!editName.trim() || !editUrl.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleTestConnection}
                      loading={testingConnection}
                      disabled={saving || !editUrl.trim()}
                    >
                      <Play className="h-3.5 w-3.5" />
                      Test connection
                    </Button>
                    {saveStatus && (
                      <span className={cn(
                        "text-[12px]",
                        saveStatus === "Saved." ? "text-status-pass" : "text-destructive",
                      )}>
                        {saveStatus}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-6">
                  <EmptyState
                    icon={<Globe className="h-8 w-8" />}
                    title="Select a credential"
                    description="Choose a credential from the list to edit details and authentication."
                    className="py-16"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <TestConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={(open) => {
          if (!testingConnection) setConnectionDialogOpen(open);
        }}
        phase={connectionPhase}
        audit={connectionAudit}
        error={connectionError}
        run={connectionRun}
        authMode={authMode}
        projectId={currentProjectId}
        environmentId={expandedEnvId}
        onRun={handleTestConnection}
        onOpenRun={(runId) => navigate(`/runs/${runId}`)}
      />
    </div>
  );
};
