import React from "react";
import { Gear, ArrowCounterClockwise, Robot, NotePencil, Eye, CursorClick } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
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
  const [selectedModelKey, setSelectedModelKey] = React.useState<ModelSlotKey>("agentModel");

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
      setModelStatus(value ? "Model updated." : "Reset to default.");
    } catch {
      setModelStatus("Failed to save model setting.");
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
      setModelStatus("All models reset to defaults.");
    } catch {
      setModelStatus("Failed to reset.");
    } finally {
      setModelSaving(null);
    }
  }

  const hasCustomizedModels = Object.values(modelSettings).some((m) => m.customized);
  const activeModel = MODEL_CONFIG.find((m) => m.key === selectedModelKey) ?? MODEL_CONFIG[0];
  const activeSetting = modelSettings[activeModel.key];

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Gear className="h-4 w-4" />}
        title="Platform Settings"
        description="Pick a model mode per agent: preset or custom."
      />

      <div className="px-6 py-5 animate-fade-in space-y-6 w-full">
        <section>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Global model controls</p>
            </div>
            {hasCustomizedModels && (
              <button
                onClick={handleResetAllModels}
                disabled={modelSaving !== null}
                className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
              >
                <ArrowCounterClockwise className="h-3 w-3" />
                Reset all
              </button>
            )}
          </div>
          <Card>
            <CardContent className="pt-4">
              <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
                <aside className="space-y-1 rounded-md border border-border/70 bg-surface-2/60 p-2">
                  {MODEL_CONFIG.map((model) => {
                    const setting = modelSettings[model.key];
                    const selected = model.key === selectedModelKey;
                    return (
                      <button
                        key={model.key}
                        type="button"
                        onClick={() => setSelectedModelKey(model.key)}
                        className={cn(
                          "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                          selected
                            ? "border-primary/40 bg-primary/10"
                            : "border-transparent hover:border-border/70 hover:bg-accent/40",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <model.Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <p className="text-[12px] font-medium text-foreground">{model.label}</p>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground/80">{model.hint}</p>
                        {setting?.customized && (
                          <Badge variant="warning" className="mt-1.5 h-4 text-[9px]">override</Badge>
                        )}
                      </button>
                    );
                  })}
                </aside>

                <div>
                  {activeSetting ? (
                    <ModelSlotCard
                      modelKey={activeModel.key}
                      label={activeModel.label}
                      hint={activeModel.hint}
                      Icon={activeModel.Icon}
                      options={activeModel.options}
                      current={activeSetting.current}
                      defaultValue={activeSetting.default}
                      customized={activeSetting.customized}
                      saving={modelSaving === activeModel.key || modelSaving === "__all__"}
                      onChange={handleModelChange}
                      llmKeys={llmKeys}
                      modelPrice={modelPrices[activeModel.key]}
                    />
                  ) : (
                    <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
                      Loading {activeModel.label}...
                    </div>
                  )}
                </div>
              </div>
              {modelStatus && (
                <p className={cn(
                  "text-[12px] mt-3",
                  modelStatus.includes("Failed") ? "text-destructive" : "text-status-pass",
                )}>
                  {modelStatus}
                </p>
              )}
            </CardContent>
          </Card>
        </section>
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
    hint: "Planning and structured outputs",
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
    case "openai":
      return "e.g. gpt-4o-mini";
    case "anthropic":
      return "e.g. claude-3-5-haiku-20241022";
    case "gemini":
      return "e.g. gemini-2.0-flash";
    case "openrouter":
      return "e.g. mistralai/mistral-small-3.1-24b-instruct";
  }
}

function normalizeModelIdForCompare(modelId: string): string {
  const value = modelId.trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("openai/")) return value.slice("openai/".length);
  if (value.startsWith("anthropic/")) return value.slice("anthropic/".length);
  if (value.startsWith("google/")) return value.slice("google/".length);
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
    if (!composed) {
      setCustomError("Enter a model id.");
      return;
    }
    const pi = parseFloat(priceIn);
    const po = parseFloat(priceOut);
    if (!Number.isFinite(pi) || !Number.isFinite(po) || pi < 0 || po < 0) {
      setCustomError("Enter USD per 1M input tokens and per 1M output tokens (non-negative numbers).");
      return;
    }
    if (llmKeys && !isModelSelectable(composed, llmKeys)) {
      const hint = modelMissingKeyLabel(composed, llmKeys);
      setCustomError(hint ?? "This model needs a different API key.");
      return;
    }
    onChange(modelKey, composed, { input: pi, output: po });
    setMode("custom");
  }

  const presetSelectValue = isPresetCurrent ? presetMatchForCurrent : "";

  return (
    <div className="rounded-md border border-border/80 bg-surface-2 p-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <label className="text-[13px] font-semibold text-foreground block truncate">{label}</label>
            <p className="text-[10px] text-muted-foreground/80 truncate">{hint}</p>
          </div>
          {customized && <Badge variant="warning" className="text-[9px] px-1.5 py-0">override</Badge>}
        </div>
        {customized && (
          <button
            type="button"
            onClick={() => onChange(modelKey, "", null)}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <ArrowCounterClockwise className="h-2.5 w-2.5" />
            Use default
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <button
          type="button"
          onClick={() => setMode("preset")}
          className={cn(
            "rounded-md border px-3 py-2 text-left transition-colors",
            mode === "preset" ? "border-primary/40 bg-primary/10" : "border-border/70 bg-surface-3/40 hover:bg-surface-3/70",
          )}
        >
          <p className="text-[11px] font-semibold">Preset</p>
          <p className="text-[10px] text-muted-foreground/80">Choose from curated models</p>
        </button>
        <button
          type="button"
          onClick={() => setMode("custom")}
          className={cn(
            "rounded-md border px-3 py-2 text-left transition-colors",
            mode === "custom" ? "border-primary/40 bg-primary/10" : "border-border/70 bg-surface-3/40 hover:bg-surface-3/70",
          )}
        >
          <p className="text-[11px] font-semibold">Custom</p>
          <p className="text-[10px] text-muted-foreground/80">Use provider + model id</p>
        </button>
      </div>

      {mode === "preset" && (
        <div className="rounded-md border border-border/70 bg-surface-3/60 p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">Model</p>
            <Select
              value={presetSelectValue}
              onChange={(e) => handlePresetChange(e.target.value)}
              disabled={saving}
              className={cn("mono-ui text-[12px] bg-background", customized && "border-primary/40")}
            >
              <option value="">Choose model…</option>
              {options.map((opt) => {
                const sel = optionSelectable(opt.value);
                const missing =
                  llmKeys && !sel && opt.value !== current ? modelMissingKeyLabel(opt.value, llmKeys) : null;
                return (
                  <option key={opt.value} value={opt.value} disabled={!sel}>
                    {opt.label}{modelIdsEquivalent(opt.value, defaultValue) ? " (default)" : ""}
                    {missing ? ` — ${missing}` : ""}
                  </option>
                );
              })}
            </Select>
          {currentOption?.price ? (
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              {currentOption.price} in/out
            </p>
          ) : null}
        </div>
      )}

      {mode === "custom" && (
        <div className="rounded-md border border-border/80 bg-muted/20 p-3 space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <Select
              value={customProvider}
              onChange={(e) => {
                setCustomProvider(e.target.value as CustomProviderId);
                setCustomError("");
              }}
              disabled={saving}
              className="sm:w-[180px] flex-shrink-0"
              aria-label="Provider"
            >
              {CUSTOM_PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input
              value={customRaw}
              onChange={(e) => {
                setCustomRaw(e.target.value);
                setCustomError("");
              }}
              disabled={saving}
              placeholder={customModelPlaceholder(customProvider)}
              className="mono-ui text-[12px] flex-1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          {customProvider === "openrouter" && (
            <p className="text-[10px] text-muted-foreground/70 leading-snug">
              Use full slug: vendor/model
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground">Input $ / 1M tokens</label>
              <Input
                type="number"
                step="any"
                min={0}
                value={priceIn}
                onChange={(e) => {
                  setPriceIn(e.target.value);
                  setCustomError("");
                }}
                disabled={saving}
                placeholder="0.40"
                className="mono-ui text-[12px] mt-0.5"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">Output $ / 1M tokens</label>
              <Input
                type="number"
                step="any"
                min={0}
                value={priceOut}
                onChange={(e) => {
                  setPriceOut(e.target.value);
                  setCustomError("");
                }}
                disabled={saving}
                placeholder="1.60"
                className="mono-ui text-[12px] mt-0.5"
              />
            </div>
          </div>
          {customError && (
            <p className="text-[11px] text-destructive">{customError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handleApplyCustom} disabled={saving} loading={saving}>
              Apply custom model
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode(isPresetCurrent ? "preset" : "custom");
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

      {!isPresetCurrent && mode === "preset" && current && (
        <p className="text-[11px] mono-ui text-muted-foreground/80 mt-2 break-all rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
          Active: {current}
          {modelPrice?.input != null && modelPrice?.output != null && (
            <span className="block text-muted-foreground/60 mt-0.5">
              Cost: ${modelPrice.input}/M in, ${modelPrice.output}/M out
            </span>
          )}
        </p>
      )}

    </div>
  );
}
