import React from "react";
import { Gear, ArrowCounterClockwise, Robot, NotePencil, Eye, CursorClick, CheckCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  fetchModelSettings, saveModelSettings, resetModelSettings,
  type LlmKeyPresence,
  type ModelPriceUsd,
  type ModelSlotKey,
  type SaveModelSettingsPayload,
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

  React.useEffect(() => {
    fetchModelSettings()
      .then((r) => {
        setModelSettings(r.models);
        setLlmKeys(r.llmKeys);
        setModelPrices(r.modelPrices ?? {});
      })
      .catch(() => {});
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

  const hasCustomizedModels = Object.values(modelSettings).some((m) => m.customized);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Gear className="h-4 w-4" />}
        title="Platform Settings"
        description="Configure the AI model powering each agent."
      />

      <div className="px-6 py-6 animate-page-enter flex-1">
        <div className="max-w-3xl mx-auto space-y-6">

          {/* Section header */}
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
  );
};

// ─── Model configuration ────────────────────────────────────────────────────

type ModelOption = { value: string; label: string; price?: string };

const AGENT_OPTIONS: ModelOption[] = [
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", price: "$0.10 / $0.40" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "openai/gpt-5-nano", label: "GPT-5 Nano", price: "$0.05 / $0.40" },
  { value: "openai/gpt-5", label: "GPT-5", price: "$1.25 / $10.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
  { value: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", price: "$15.00 / $75.00" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
];

const REASONING_VISION_OPTIONS: ModelOption[] = [
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", price: "$15.00 / $75.00" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "openai/o3", label: "o3", price: "$2.00 / $8.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
];

const CODE_OPTIONS: ModelOption[] = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-5", label: "GPT-5", price: "$1.25 / $10.00" },
  { value: "openai/o3-mini", label: "o3-mini", price: "$1.10 / $4.40" },
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", price: "$0.26 / $0.38" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", price: "varies" },
];

const STAGEHAND_OPTIONS: ModelOption[] = [
  { value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", price: "$0.10 / $0.40" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.15 / $0.60" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (short id)", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
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
    label: "Support agent",
    hint: "Planning & structured outputs",
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
  {
    key: "stagehandModel",
    label: "Element finder",
    hint: "UI targeting reliability",
    Icon: CursorClick,
    options: STAGEHAND_OPTIONS,
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

