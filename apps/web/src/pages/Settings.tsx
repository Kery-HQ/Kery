import React from "react";
import {
  Gear, ArrowCounterClockwise, Robot, NotePencil, Eye, CursorClick, CheckCircle,
  Key, Eye as EyeIcon, EyeSlash, Trash, PencilSimple, Warning, Queue,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Separator } from "@/components/ui/separator";
import {
  fetchModelSettings, saveModelSettings, resetModelSettings,
  fetchApiKeySettings, saveApiKeys, deleteApiKey,
  fetchPlatformSettings, savePlatformSettings,
  type LlmKeyPresence,
  type ModelPriceUsd,
  type ModelSlotKey,
  type SaveModelSettingsPayload,
  type ApiKeyProvider,
  type ApiKeyInfo,
  type ApiKeySettingsResponse,
  type PlatformSettingsResponse,
} from "@/projectApi";
import {
  isModelSelectable,
  modelMissingKeyLabel,
  composeCustomModel,
  parseStoredModelForCustomUi,
  type CustomProviderId,
} from "@/lib/llmModelAvailability";
import { cn } from "@/lib/utils";

export const Settings: React.FC = () => {
  const [modelSettings, setModelSettings] = React.useState<Record<string, { current: string; default: string; customized: boolean }>>({});
  const [llmKeys, setLlmKeys] = React.useState<LlmKeyPresence | null>(null);
  const [modelPrices, setModelPrices] = React.useState<Partial<Record<ModelSlotKey, ModelPriceUsd>>>({});
  const [modelSaving, setModelSaving] = React.useState<string | null>(null);
  const [modelStatus, setModelStatus] = React.useState("");
  const [apiKeySettings, setApiKeySettings] = React.useState<ApiKeySettingsResponse | null>(null);
  const [platformSettings, setPlatformSettings] = React.useState<PlatformSettingsResponse | null>(null);
  const [concurrencyValue, setConcurrencyValue] = React.useState<number>(3);
  const [concurrencySaving, setConcurrencySaving] = React.useState(false);
  const [concurrencyStatus, setConcurrencyStatus] = React.useState("");

  async function refreshAll() {
    const [modelRes, keyRes, platformRes] = await Promise.all([
      fetchModelSettings().catch(() => null),
      fetchApiKeySettings().catch(() => null),
      fetchPlatformSettings().catch(() => null),
    ]);
    if (modelRes) {
      setModelSettings(modelRes.models);
      setLlmKeys(modelRes.llmKeys);
      setModelPrices(modelRes.modelPrices ?? {});
    }
    if (keyRes) setApiKeySettings(keyRes);
    if (platformRes) {
      setPlatformSettings(platformRes);
      setConcurrencyValue(platformRes.maxConcurrency);
    }
  }

  React.useEffect(() => {
    refreshAll();
  }, []);

  async function handleModelChange(key: ModelSlotKey, value: string, modelPrice?: ModelPriceUsd | null) {
    setModelSaving(key);
    setModelStatus("");
    try {
      const payload: SaveModelSettingsPayload = { [key]: value };
      if (modelPrice !== undefined) {
        payload.modelPrices = { [key]: modelPrice };
      }
      await saveModelSettings(payload);
      const r = await fetchModelSettings();
      setModelSettings(r.models);
      setLlmKeys(r.llmKeys);
      setModelPrices(r.modelPrices ?? {});
      setModelStatus(value ? "saved" : "reset");
    } catch {
      setModelStatus("error");
    } finally {
      setModelSaving(null);
    }
  }

  async function handleResetAllModels() {
    setModelSaving("__all__");
    setModelStatus("");
    try {
      await resetModelSettings();
      const r = await fetchModelSettings();
      setModelSettings(r.models);
      setLlmKeys(r.llmKeys);
      setModelPrices(r.modelPrices ?? {});
      setModelStatus("reset");
    } catch {
      setModelStatus("error");
    } finally {
      setModelSaving(null);
    }
  }

  async function handleApiKeyChange(provider: ApiKeyProvider, value: string | null) {
    if (value === null) {
      await deleteApiKey(provider);
    } else {
      await saveApiKeys({ [provider]: value });
    }
    // Refresh both — key presence affects model availability
    await refreshAll();
  }

  async function handleConcurrencySave() {
    setConcurrencySaving(true);
    setConcurrencyStatus("");
    try {
      await savePlatformSettings({ maxConcurrency: concurrencyValue });
      setConcurrencyStatus("saved");
    } catch {
      setConcurrencyStatus("error");
    } finally {
      setConcurrencySaving(false);
    }
  }

  const hasCustomizedModels = Object.values(modelSettings).some((m) => m.customized);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Gear className="h-4 w-4" />}
        title="Platform Settings"
        description="Configure API keys and the AI models powering each agent."
      />

      <div className="px-6 py-6 animate-page-enter flex-1">
        <div className="max-w-3xl mx-auto space-y-8">

          {/* ── API Keys section ── */}
          <div className="space-y-4">
            <div>
              <h2 className="text-[14px] font-semibold text-foreground">API Keys</h2>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                Keys saved here override your <span className="font-mono text-[11px]">.env</span> values and unlock additional models. Stored encrypted in the database.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {API_KEY_CONFIG.map((cfg, i) => {
                const info = apiKeySettings?.[cfg.provider];
                return (
                  <div
                    key={cfg.provider}
                    className="glass-card-flat card-stagger"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <ApiKeyCard
                      provider={cfg.provider}
                      label={cfg.label}
                      docsUrl={cfg.docsUrl}
                      info={info ?? null}
                      onChange={handleApiKeyChange}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* ── Platform section ── */}
          <div className="space-y-4">
            <div>
              <h2 className="text-[14px] font-semibold text-foreground">Run execution</h2>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                Control how many test runs execute in parallel. Takes effect on the next worker restart.
              </p>
            </div>

            <div className="glass-card-flat">
              <div className="p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Queue className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-foreground">Max concurrency</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Maximum number of runs executing simultaneously. Default 3, max 10.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={platformSettings?.maxConcurrencyLimit ?? 10}
                    step={1}
                    value={concurrencyValue}
                    onChange={(e) => { setConcurrencyValue(Number(e.target.value)); setConcurrencyStatus(""); }}
                    disabled={concurrencySaving || !platformSettings}
                    className="flex-1 accent-primary disabled:opacity-40"
                  />
                  <span className="font-mono text-[14px] font-semibold text-foreground w-6 text-center shrink-0">
                    {concurrencyValue}
                  </span>
                  <Button
                    size="sm"
                    onClick={handleConcurrencySave}
                    disabled={concurrencySaving || !platformSettings || concurrencyValue === platformSettings?.maxConcurrency}
                    loading={concurrencySaving}
                  >
                    Save
                  </Button>
                </div>

                {concurrencyStatus && (
                  <div className={cn(
                    "flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg border animate-fade-in",
                    concurrencyStatus === "error"
                      ? "border-destructive/30 bg-destructive/8 text-destructive"
                      : "border-status-pass/30 bg-status-pass/8 text-status-pass",
                  )}>
                    <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                    {concurrencyStatus === "saved" && "Concurrency saved. Restart the worker to apply."}
                    {concurrencyStatus === "error" && "Failed to save — please try again."}
                  </div>
                )}
              </div>
            </div>
          </div>

          <Separator />

          {/* ── Model agents section ── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[14px] font-semibold text-foreground">Model agents</h2>
                <p className="text-[12px] text-muted-foreground mt-0.5">
                  Choose a preset or enter a custom model id for each agent role.
                </p>
              </div>
              {hasCustomizedModels && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetAllModels}
                  disabled={modelSaving !== null}
                >
                  <ArrowCounterClockwise className="h-3.5 w-3.5 mr-1.5" />
                  Reset all
                </Button>
              )}
            </div>

            {/* Model cards grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {MODEL_CONFIG.map((model, i) => {
                const setting = modelSettings[model.key];
                return (
                  <div
                    key={model.key}
                    className="glass-card-flat card-stagger"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    {setting ? (
                      <ModelSlotCard
                        modelKey={model.key}
                        label={model.label}
                        hint={model.hint}
                        Icon={model.Icon}
                        options={model.options}
                        current={setting.current}
                        defaultValue={setting.default}
                        customized={setting.customized}
                        saving={modelSaving === model.key || modelSaving === "__all__"}
                        onChange={handleModelChange}
                        llmKeys={llmKeys}
                        modelPrice={modelPrices[model.key]}
                      />
                    ) : (
                      <div className="p-4 space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-xl bg-foreground/6 animate-pulse" />
                          <div className="space-y-1.5">
                            <div className="h-3 w-28 rounded bg-foreground/6 animate-pulse" />
                            <div className="h-2.5 w-20 rounded bg-foreground/4 animate-pulse" />
                          </div>
                        </div>
                        <div className="h-9 w-full rounded-lg bg-foreground/4 animate-pulse" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Status toast */}
            {modelStatus && (
              <div className={cn(
                "flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg border animate-fade-in",
                modelStatus === "error"
                  ? "border-destructive/30 bg-destructive/8 text-destructive"
                  : "border-status-pass/30 bg-status-pass/8 text-status-pass",
              )}>
                <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                {modelStatus === "saved" && "Model saved successfully."}
                {modelStatus === "reset" && "Reset to defaults."}
                {modelStatus === "error" && "Failed to save — please try again."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── API Key configuration ──────────────────────────────────────────────────

const API_KEY_CONFIG: {
  provider: ApiKeyProvider;
  label: string;
  docsUrl: string;
  placeholder: string;
}[] = [
  {
    provider: "openai",
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-proj-…",
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
  },
  {
    provider: "gemini",
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-v1-…",
  },
];

function ApiKeyCard({
  provider,
  label,
  docsUrl,
  info,
  onChange,
}: {
  provider: ApiKeyProvider;
  label: string;
  docsUrl: string;
  info: ApiKeyInfo | null;
  onChange: (provider: ApiKeyProvider, value: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [keyValue, setKeyValue] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!editing) { setKeyValue(""); setShowKey(false); setError(""); }
  }, [editing]);

  async function handleSave() {
    if (!keyValue.trim()) { setError("Enter an API key."); return; }
    setSaving(true);
    setError("");
    try {
      await onChange(provider, keyValue.trim());
      setEditing(false);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setSaving(true);
    try {
      await onChange(provider, null);
      setConfirmDelete(false);
    } catch {
      setError("Failed to remove key.");
    } finally {
      setSaving(false);
    }
  }

  const isLoading = info === null;
  const source = info?.source ?? "none";
  const hasDbKey = source === "db";
  const hasEnvKey = source === "env";
  const hasKey = info?.hasKey ?? false;

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={cn(
            "h-8 w-8 rounded-xl flex items-center justify-center shrink-0",
            hasKey ? "bg-primary/10 text-primary" : "bg-foreground/6 text-muted-foreground",
          )}>
            <Key className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{label}</p>
          </div>
        </div>

        {isLoading ? (
          <div className="h-5 w-16 rounded bg-foreground/6 animate-pulse shrink-0" />
        ) : (
          <div className="shrink-0">
            {hasDbKey && <Badge variant="success" className="text-[10px] px-1.5 h-4 font-medium">DB override</Badge>}
            {hasEnvKey && !hasDbKey && <Badge variant="neutral" className="text-[10px] px-1.5 h-4 font-medium">From .env</Badge>}
            {!hasKey && <Badge variant="warning" className="text-[10px] px-1.5 h-4 font-medium">Not configured</Badge>}
          </div>
        )}
      </div>

      {/* Key display */}
      {!editing && (
        <div className="space-y-2">
          {isLoading ? (
            <div className="h-8 w-full rounded-lg bg-foreground/4 animate-pulse" />
          ) : (
            <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 flex items-center justify-between gap-2 min-h-[34px]">
              <div className="min-w-0">
                {hasDbKey && info?.maskedKey && (
                  <p className="font-mono text-[11px] text-foreground/70 truncate">{info.maskedKey}</p>
                )}
                {hasEnvKey && (
                  <p className="text-[11px] text-muted-foreground truncate">Configured via environment variable</p>
                )}
                {!hasKey && (
                  <p className="text-[11px] text-muted-foreground/60 truncate italic">No key configured</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {hasDbKey && (
                  <button
                    type="button"
                    onClick={() => { setConfirmDelete(false); handleDelete(); }}
                    disabled={saving}
                    title="Remove DB override"
                    className="text-muted-foreground/50 hover:text-destructive transition-colors disabled:opacity-40 p-0.5"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={isLoading || saving}
              className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors py-1 px-1.5 rounded-md hover:bg-foreground/4 flex items-center gap-1 disabled:opacity-40"
            >
              <PencilSimple className="h-3 w-3" />
              {hasDbKey ? "Update key" : hasEnvKey ? "Override with DB key" : "Add key"}
            </button>
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors py-1 px-1.5 rounded-md hover:bg-foreground/4"
            >
              Get key →
            </a>
          </div>

          {confirmDelete && (
            <div className="flex items-center gap-2 text-[11px] text-destructive animate-fade-in">
              <Warning className="h-3.5 w-3.5 shrink-0" />
              <span>Remove DB key? (falls back to .env)</span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="underline underline-offset-2 hover:opacity-80 disabled:opacity-40"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="space-y-2.5 rounded-lg border border-border/70 bg-background/30 p-3 animate-fade-in">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] font-medium text-foreground">
              {hasDbKey ? "Update API key" : hasEnvKey ? "Override with DB key" : "Add API key"}
            </p>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>

          {hasEnvKey && !hasDbKey && (
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
              You already have a key set in <span className="font-mono">.env</span>. Adding one here will override it without changing your environment file.
            </p>
          )}

          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              value={keyValue}
              onChange={(e) => { setKeyValue(e.target.value); setError(""); }}
              placeholder={API_KEY_CONFIG.find(c => c.provider === provider)?.placeholder ?? "sk-…"}
              className="mono-ui text-[11px] pr-9"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showKey ? <EyeSlash className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
            </button>
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          <div className="flex gap-2 pt-0.5">
            <Button type="button" size="sm" onClick={handleSave} disabled={saving} loading={saving}>
              Save key
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Model configuration ────────────────────────────────────────────────────

type ModelOption = { value: string; label: string; price?: string };

const AGENT_OPTIONS: ModelOption[] = [
  // GPT-5.4 family (current flagship)
  { value: "openai/gpt-5.4", label: "GPT-5.4", price: "$2.50 / $15.00" },
  { value: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", price: "$0.75 / $4.50" },
  { value: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano", price: "$0.20 / $1.25" },
  // GPT-5 family
  { value: "openai/gpt-5", label: "GPT-5", price: "$1.25 / $10.00" },
  { value: "openai/gpt-5-nano", label: "GPT-5 Nano", price: "$0.05 / $0.40" },
  // GPT-4.1 family
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", price: "$0.10 / $0.40" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  // Anthropic
  { value: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", price: "$5.00 / $25.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
  { value: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", price: "$5.00 / $25.00" },
  // Gemini (direct API)
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  // Gemini 3 series
  { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview", price: "$0.50 / $3.00" },
  { value: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview", price: "$0.25 / $1.50" },
];

const REASONING_VISION_OPTIONS: ModelOption[] = [
  // Anthropic
  { value: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", price: "$5.00 / $25.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", price: "$5.00 / $25.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
  // Gemini 3
  { value: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", price: "$2.00 / $12.00" },
  { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview", price: "$0.50 / $3.00" },
  // Gemini 2.5 (direct API)
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  // OpenAI
  { value: "openai/gpt-5.4", label: "GPT-5.4", price: "$2.50 / $15.00" },
  { value: "openai/o4-mini", label: "o4-mini", price: "$1.10 / $4.40" },
  { value: "openai/o3", label: "o3", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
];

const CODE_OPTIONS: ModelOption[] = [
  // GPT-5.4 family
  { value: "openai/gpt-5.4", label: "GPT-5.4", price: "$2.50 / $15.00" },
  { value: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", price: "$0.75 / $4.50" },
  // Anthropic
  { value: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", price: "$5.00 / $25.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
  // Gemini 3
  { value: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", price: "$2.00 / $12.00" },
  { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview", price: "$0.50 / $3.00" },
  { value: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview", price: "$0.25 / $1.50" },
  // Gemini 2.5 (direct API)
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  // GPT-4.1 / GPT-5
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-5", label: "GPT-5", price: "$1.25 / $10.00" },
  { value: "openai/o4-mini", label: "o4-mini", price: "$1.10 / $4.40" },
  { value: "openai/o3-mini", label: "o3-mini", price: "$1.10 / $4.40" },
  // OpenRouter-only
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", price: "$0.26 / $0.38" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", price: "varies" },
];

const STAGEHAND_OPTIONS: ModelOption[] = [
  // Gemini 3 — best for visual element targeting
  { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview", price: "$0.50 / $3.00" },
  { value: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview", price: "$0.25 / $1.50" },
  // Gemini 2.5 (direct API)
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (short id)", price: "$0.15 / $0.60" },
  { value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", price: "$0.10 / $0.40" },
  // Anthropic
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
  // OpenAI
  { value: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", price: "$0.75 / $4.50" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
];

const CUSTOM_PROVIDER_OPTIONS: { value: CustomProviderId; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter (any id)" },
];

const MODEL_CONFIG: {
  key: ModelSlotKey;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ className?: string }>;
  options: ModelOption[];
}[] = [
  {
    key: "agentModel",
    label: "Navigator agent",
    hint: "Primary browser actions",
    Icon: Robot,
    options: AGENT_OPTIONS,
  },
  {
    key: "auxiliaryModel",
    label: "Support system",
    hint: "Planning, triage, and memory curation",
    Icon: NotePencil,
    options: CODE_OPTIONS,
  },
  {
    key: "reviewAgentModel",
    label: "Review agent",
    hint: "Post-run visual checks",
    Icon: Eye,
    options: REASONING_VISION_OPTIONS,
  },
];

function customModelPlaceholder(provider: CustomProviderId): string {
  switch (provider) {
    case "openai":     return "e.g. gpt-4o-mini";
    case "anthropic":  return "e.g. claude-3-5-haiku-20241022";
    case "gemini":     return "e.g. gemini-2.0-flash";
    case "openrouter": return "e.g. mistralai/mistral-small-3.1-24b-instruct";
  }
}

function normalizeModelIdForCompare(modelId: string): string {
  const value = modelId.trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("openai/"))    return value.slice("openai/".length);
  if (value.startsWith("anthropic/")) return value.slice("anthropic/".length);
  if (value.startsWith("google/"))    return value.slice("google/".length);
  return value;
}

function modelIdsEquivalent(a: string, b: string): boolean {
  return normalizeModelIdForCompare(a) === normalizeModelIdForCompare(b);
}

function ModelSlotCard({
  modelKey,
  label,
  hint,
  Icon,
  options,
  current,
  defaultValue,
  customized,
  saving,
  onChange,
  llmKeys,
  modelPrice,
}: {
  modelKey: ModelSlotKey;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ className?: string }>;
  options: ModelOption[];
  current: string;
  defaultValue: string;
  customized: boolean;
  saving: boolean;
  onChange: (key: ModelSlotKey, value: string, modelPrice?: ModelPriceUsd | null) => void;
  llmKeys: LlmKeyPresence | null;
  modelPrice?: ModelPriceUsd;
}) {
  const presetValues = React.useMemo(() => new Set(options.map((o) => o.value)), [options]);
  const presetMatchForCurrent = React.useMemo(
    () => options.find((o) => modelIdsEquivalent(o.value, current))?.value ?? "",
    [options, current],
  );
  const isPresetCurrent = Boolean(presetMatchForCurrent);
  const currentOption = React.useMemo(
    () => options.find((o) => modelIdsEquivalent(o.value, current)),
    [options, current],
  );

  const [expanded, setExpanded] = React.useState(false);
  const [mode, setMode] = React.useState<"preset" | "custom">(!isPresetCurrent && current.length > 0 ? "custom" : "preset");
  const [customProvider, setCustomProvider] = React.useState<CustomProviderId>("openai");
  const [customRaw, setCustomRaw] = React.useState("");
  const [customError, setCustomError] = React.useState("");
  const [priceIn, setPriceIn] = React.useState("");
  const [priceOut, setPriceOut] = React.useState("");

  React.useEffect(() => {
    if (!presetValues.has(current) && current.length > 0) setMode("custom");
    if (presetValues.has(current)) setMode("preset");
  }, [current, presetValues]);

  React.useEffect(() => {
    const p = parseStoredModelForCustomUi(current);
    setCustomProvider(p.provider);
    setCustomRaw(p.raw);
  }, [current, modelKey]);

  React.useEffect(() => {
    if (modelPrice) {
      setPriceIn(String(modelPrice.input));
      setPriceOut(String(modelPrice.output));
    } else {
      setPriceIn("");
      setPriceOut("");
    }
  }, [modelPrice, modelKey]);

  function optionSelectable(optValue: string): boolean {
    if (!llmKeys) return true;
    if (modelIdsEquivalent(optValue, current)) return true;
    return isModelSelectable(optValue, llmKeys);
  }

  function handlePresetChange(value: string) {
    if (!value) return;
    setMode("preset");
    setCustomError("");
    onChange(modelKey, value, null);
  }

  function handleApplyCustom() {
    setCustomError("");
    const composed = composeCustomModel(customProvider, customRaw);
    if (!composed) { setCustomError("Enter a model id."); return; }
    const pi = parseFloat(priceIn);
    const po = parseFloat(priceOut);
    if (!Number.isFinite(pi) || !Number.isFinite(po) || pi < 0 || po < 0) {
      setCustomError("Enter USD / 1M tokens for input and output (non-negative).");
      return;
    }
    if (llmKeys && !isModelSelectable(composed, llmKeys)) {
      const hint = modelMissingKeyLabel(composed, llmKeys);
      setCustomError(hint ?? "This model needs a different API key.");
      return;
    }
    onChange(modelKey, composed, { input: pi, output: po });
    setMode("custom");
    setExpanded(false);
  }

  const presetSelectValue = isPresetCurrent ? presetMatchForCurrent : "";
  const displayModelLabel = currentOption?.label ?? (current ? current : "Default");

  return (
    <div className="p-4 space-y-3">
      {/* Card header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{label}</p>
            <p className="text-[11px] text-muted-foreground truncate">{hint}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {customized && <Badge variant="warning" className="text-[9px] px-1.5 h-4">custom</Badge>}
          {customized && (
            <button
              type="button"
              onClick={() => onChange(modelKey, "", null)}
              disabled={saving}
              title="Reset to default"
              className="text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
            >
              <ArrowCounterClockwise className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Current model display + quick-select */}
      {!expanded ? (
        <div className="space-y-2">
          <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-foreground truncate">{displayModelLabel}</p>
              {currentOption?.price && (
                <p className="text-[10px] text-muted-foreground/70 truncate">{currentOption.price} per 1M in/out</p>
              )}
              {!isPresetCurrent && current && (
                <p className="text-[10px] font-mono text-muted-foreground/60 truncate">{current}</p>
              )}
            </div>
            {saving && (
              <div className="h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary animate-spin shrink-0" />
            )}
          </div>

          {/* Preset select — inline quick change */}
          <Select
            value={presetSelectValue}
            onChange={(e) => handlePresetChange(e.target.value)}
            disabled={saving}
            className="text-[12px]"
          >
            <option value="">Choose preset model…</option>
            {options.map((opt) => {
              const sel = optionSelectable(opt.value);
              const missing = llmKeys && !sel && opt.value !== current ? modelMissingKeyLabel(opt.value, llmKeys) : null;
              return (
                <option key={opt.value} value={opt.value} disabled={!sel}>
                  {opt.label}{modelIdsEquivalent(opt.value, defaultValue) ? " (default)" : ""}
                  {missing ? ` — ${missing}` : ""}
                </option>
              );
            })}
          </Select>

          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors py-1 rounded-md hover:bg-foreground/4"
          >
            Use custom model →
          </button>
        </div>
      ) : (
        /* Expanded custom form */
        <div className="space-y-2.5 rounded-lg border border-border/70 bg-background/30 p-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] font-medium text-foreground">Custom model</p>
            <button
              type="button"
              onClick={() => { setExpanded(false); setCustomError(""); }}
              className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <Select
              value={customProvider}
              onChange={(e) => { setCustomProvider(e.target.value as CustomProviderId); setCustomError(""); }}
              disabled={saving}
              className="sm:w-[140px] flex-shrink-0 text-[11px]"
              aria-label="Provider"
            >
              {CUSTOM_PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <Input
              value={customRaw}
              onChange={(e) => { setCustomRaw(e.target.value); setCustomError(""); }}
              disabled={saving}
              placeholder={customModelPlaceholder(customProvider)}
              className="mono-ui text-[11px] flex-1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>

          {customProvider === "openrouter" && (
            <p className="text-[10px] text-muted-foreground/60">Use full slug: vendor/model</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">Input $ / 1M tokens</label>
              <Input
                type="number" step="any" min={0}
                value={priceIn}
                onChange={(e) => { setPriceIn(e.target.value); setCustomError(""); }}
                disabled={saving}
                placeholder="0.40"
                className="mono-ui text-[11px]"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">Output $ / 1M tokens</label>
              <Input
                type="number" step="any" min={0}
                value={priceOut}
                onChange={(e) => { setPriceOut(e.target.value); setCustomError(""); }}
                disabled={saving}
                placeholder="1.60"
                className="mono-ui text-[11px]"
              />
            </div>
          </div>

          {customError && <p className="text-[11px] text-destructive">{customError}</p>}

          <div className="flex gap-2 pt-0.5">
            <Button type="button" size="sm" onClick={handleApplyCustom} disabled={saving} loading={saving}>
              Apply
            </Button>
            <Button
              type="button" variant="ghost" size="sm"
              onClick={() => {
                setCustomError("");
                const p = parseStoredModelForCustomUi(current);
                setCustomProvider(p.provider);
                setCustomRaw(p.raw);
              }}
              disabled={saving}
            >
              Reset form
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}







