import React from "react";
import { Settings as SettingsIcon, Trash2, RotateCcw, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { useProject } from "@/lib/projectContext";
import {
  updateProject, deleteProject,
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
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

export const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject, refreshProjects, setCurrentProjectId, projects } = useProject();

  const [projectName, setProjectName] = React.useState("");
  const [nameSaving, setNameSaving] = React.useState(false);
  const [nameStatus, setNameStatus] = React.useState("");

  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const [modelSettings, setModelSettings] = React.useState<Record<string, { current: string; default: string; customized: boolean }>>({});
  const [llmKeys, setLlmKeys] = React.useState<LlmKeyPresence | null>(null);
  const [modelPrices, setModelPrices] = React.useState<Partial<Record<ModelSlotKey, ModelPriceUsd>>>({});
  const [modelSaving, setModelSaving] = React.useState<string | null>(null);
  const [modelStatus, setModelStatus] = React.useState("");

  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setProjectName(currentProject?.name ?? "");
    setNameStatus("");
    setDeleteConfirm("");
  }, [currentProject?.id]);

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

  async function handleRename() {
    if (!currentProjectId || !projectName.trim() || projectName.trim() === currentProject?.name) return;
    setNameSaving(true);
    try {
      await updateProject(currentProjectId, projectName.trim());
      await refreshProjects();
      setNameStatus("Project renamed.");
    } catch {
      setNameStatus("Failed to rename.");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleDelete() {
    if (!currentProjectId || deleteConfirm !== currentProject?.name) return;
    setDeleting(true);
    await deleteProject(currentProjectId);
    await refreshProjects();
    const next = projects.find((p) => p.id !== currentProjectId);
    if (next) {
      setCurrentProjectId(next.id);
    }
    navigate("/overview");
  }

  function copyProjectId() {
    if (!currentProjectId) return;
    navigator.clipboard.writeText(currentProjectId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!currentProjectId || !currentProject) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<SettingsIcon className="h-4 w-4" />} title="Settings" />
        <EmptyState
          icon={<SettingsIcon className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view settings."
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader icon={<SettingsIcon className="h-4 w-4" />} title="Settings" />

      <div className="px-6 py-5 animate-fade-in max-w-xl space-y-6 mx-auto w-full">

        {/* General */}
        <section>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
            General
          </p>
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Project name</label>
                <div className="flex gap-2">
                  <Input
                    value={projectName}
                    onChange={(e) => { setProjectName(e.target.value); setNameStatus(""); }}
                    onKeyDown={(e) => e.key === "Enter" && handleRename()}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={handleRename}
                    loading={nameSaving}
                    disabled={!projectName.trim() || projectName.trim() === currentProject.name}
                  >
                    Rename
                  </Button>
                </div>
                {nameStatus && (
                  <p className={cn(
                    "text-[12px] mt-1.5",
                    nameStatus.includes("Failed") ? "text-destructive" : "text-status-pass",
                  )}>
                    {nameStatus}
                  </p>
                )}
              </div>
              <Separator />
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Project ID</label>
                <div className="flex items-center gap-2">
                  <p className="text-[12px] font-mono text-muted-foreground bg-muted/50 rounded-md px-3 py-1.5 border border-border flex-1 select-all">
                    {currentProjectId}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={copyProjectId}
                    className="h-7 w-7 flex-shrink-0"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-status-pass" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Models */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Models
            </p>
            {Object.values(modelSettings).some((m) => m.customized) && (
              <button
                onClick={handleResetAllModels}
                disabled={modelSaving !== null}
                className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                Reset all
              </button>
            )}
          </div>
          <Card>
            <CardContent className="pt-4 space-y-4">
              {MODEL_CONFIG.map(({ key, label, description, options }, idx) => {
                const setting = modelSettings[key];
                if (!setting) return null;
                return (
                  <React.Fragment key={key}>
                    {idx > 0 && <Separator />}
                    <ModelSelect
                      key={key}
                      modelKey={key as ModelSlotKey}
                      label={label}
                      description={description}
                      options={options}
                      current={setting.current}
                      defaultValue={setting.default}
                      customized={setting.customized}
                      saving={modelSaving === key || modelSaving === "__all__"}
                      onChange={handleModelChange}
                      llmKeys={llmKeys}
                      modelPrice={modelPrices[key as ModelSlotKey]}
                    />
                  </React.Fragment>
                );
              })}
              {modelStatus && (
                <p className={cn(
                  "text-[12px]",
                  modelStatus.includes("Failed") ? "text-destructive" : "text-status-pass",
                )}>
                  {modelStatus}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Danger zone */}
        <section>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-destructive/60 mb-3">
            Danger zone
          </p>
          <Card className="border-destructive/30">
            <CardContent className="pt-4">
              <p className="text-[13px] font-semibold text-foreground">Delete project</p>
              <p className="text-[12px] text-muted-foreground mt-0.5 mb-3">
                This permanently deletes the project and all its environments, tests, runs, and memory. This cannot be undone.
              </p>
              <Dialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteConfirm(""); }}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="gap-1.5">
                    <Trash2 className="h-3 w-3" />
                    Delete project
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete Project</DialogTitle>
                    <DialogDescription>
                      This will permanently delete <span className="font-semibold text-foreground">"{currentProject.name}"</span> and all associated data.
                    </DialogDescription>
                  </DialogHeader>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                      Type <span className="font-mono font-semibold text-foreground">"{currentProject.name}"</span> to confirm
                    </label>
                    <Input
                      value={deleteConfirm}
                      onChange={(e) => setDeleteConfirm(e.target.value)}
                      placeholder={currentProject.name}
                      className="border-destructive/30"
                    />
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost" size="sm">Cancel</Button>
                    </DialogClose>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                      loading={deleting}
                      disabled={deleteConfirm !== currentProject.name}
                    >
                      Delete project
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
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

const MODEL_CONFIG: { key: string; label: string; description: string; options: ModelOption[] }[] = [
  {
    key: "agentModel",
    label: "Agent Model",
    description: "Browser automation decisions -- needs fast tool calling",
    options: AGENT_OPTIONS,
  },
  {
    key: "crawlModel",
    label: "Crawl Model",
    description: "Crawl tasks, destination path / test plan generation, per-page intents -- text & JSON",
    options: CODE_OPTIONS,
  },
  {
    key: "reviewAgentModel",
    label: "Review Agent Model",
    description: "Post-run holistic & filmstrip screenshot analysis -- strong vision + reasoning",
    options: REASONING_VISION_OPTIONS,
  },
  {
    key: "stagehandModel",
    label: "Stagehand Model",
    description: "Smart element finding via Stagehand",
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

function ModelSelect({
  modelKey,
  label,
  description,
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
  description: string;
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
  const isPresetCurrent = presetValues.has(current);

  const [customOpen, setCustomOpen] = React.useState(!isPresetCurrent && current.length > 0);
  const [customProvider, setCustomProvider] = React.useState<CustomProviderId>("openai");
  const [customRaw, setCustomRaw] = React.useState("");
  const [customError, setCustomError] = React.useState("");
  const [priceIn, setPriceIn] = React.useState("");
  const [priceOut, setPriceOut] = React.useState("");

  React.useEffect(() => {
    if (!presetValues.has(current) && current.length > 0) setCustomOpen(true);
    if (presetValues.has(current)) setCustomOpen(false);
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
    if (optValue === current) return true;
    return isModelSelectable(optValue, llmKeys);
  }

  function handlePresetChange(value: string) {
    if (!value) return;
    setCustomOpen(false);
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
    setCustomOpen(false);
  }

  const presetSelectValue = isPresetCurrent ? current : "";

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <label className="text-[12px] font-medium text-foreground/80">{label}</label>
          {customized && (
            <Badge variant="warning" className="text-[9px] px-1.5 py-0">customized</Badge>
          )}
        </div>
        {customized && (
          <button
            type="button"
            onClick={() => onChange(modelKey, "", null)}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Reset
          </button>
        )}
      </div>

      {!customOpen && (
        <>
          <Select
            value={presetSelectValue}
            onChange={(e) => handlePresetChange(e.target.value)}
            disabled={saving}
            className={cn(customized && "border-primary/40")}
          >
            <option value="">Choose a preset…</option>
            {options.map((opt) => {
              const sel = optionSelectable(opt.value);
              const missing =
                llmKeys && !sel && opt.value !== current ? modelMissingKeyLabel(opt.value, llmKeys) : null;
              return (
                <option key={opt.value} value={opt.value} disabled={!sel}>
                  {opt.label}{opt.price ? ` -- ${opt.price}` : ""}{opt.value === defaultValue ? " (default)" : ""}
                  {missing ? ` — ${missing}` : ""}
                </option>
              );
            })}
          </Select>
          <button
            type="button"
            onClick={() => {
              setCustomOpen(true);
              setCustomError("");
            }}
            disabled={saving}
            className="mt-1.5 text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
          >
            Custom model (provider + id)
          </button>
        </>
      )}

      {customOpen && (
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
              className="font-mono text-[12px] flex-1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          {customProvider === "openrouter" && (
            <p className="text-[10px] text-muted-foreground/70 leading-snug">
              Use the full OpenRouter slug (vendor/model). Requires OPENROUTER_API_KEY unless another rule matches.
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
                className="font-mono text-[12px] mt-0.5"
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
                className="font-mono text-[12px] mt-0.5"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70 leading-snug">
            Required for cost estimates. Use your provider’s published pricing (USD per million tokens).
          </p>
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
                setCustomOpen(false);
                setCustomError("");
                const p = parseStoredModelForCustomUi(current);
                setCustomProvider(p.provider);
                setCustomRaw(p.raw);
              }}
              disabled={saving}
            >
              {isPresetCurrent ? "Cancel" : "Use presets"}
            </Button>
          </div>
        </div>
      )}

      {!isPresetCurrent && !customOpen && current && (
        <p className="text-[11px] font-mono text-muted-foreground/80 mt-1.5 break-all">
          Active: {current}
          {modelPrice?.input != null && modelPrice?.output != null && (
            <span className="block text-muted-foreground/60 mt-0.5">
              Cost: ${modelPrice.input}/M in, ${modelPrice.output}/M out
            </span>
          )}
        </p>
      )}

      <p className="text-[11px] text-muted-foreground/60 mt-1">{description}</p>
    </div>
  );
}
