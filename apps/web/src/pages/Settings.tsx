import React from "react";
import { Settings as SettingsIcon, Trash2, Check, RotateCcw, ChevronDown } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useProject } from "../lib/projectContext";
import { updateProject, deleteProject, fetchRunSettings, saveRunSettings, fetchModelSettings, saveModelSettings, resetModelSettings } from "../projectApi";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/utils";

export const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject, refreshProjects, setCurrentProjectId, projects } = useProject();

  const [projectName, setProjectName] = React.useState("");
  const [nameSaving, setNameSaving] = React.useState(false);
  const [nameStatus, setNameStatus] = React.useState("");

  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  const [useLocalPlaywright, setUseLocalPlaywright] = React.useState(false);
  const [runSettingsSaving, setRunSettingsSaving] = React.useState(false);

  const [modelSettings, setModelSettings] = React.useState<Record<string, { current: string; default: string; customized: boolean }>>({});
  const [modelSaving, setModelSaving] = React.useState<string | null>(null);
  const [modelStatus, setModelStatus] = React.useState("");

  React.useEffect(() => {
    setProjectName(currentProject?.name ?? "");
    setNameStatus("");
    setDeleteConfirm("");
  }, [currentProject?.id]);

  React.useEffect(() => {
    if (!currentProjectId) return;
    fetchRunSettings(currentProjectId)
      .then((r: any) => setUseLocalPlaywright(r?.useLocalPlaywright ?? false))
      .catch(() => {});
  }, [currentProjectId]);

  React.useEffect(() => {
    fetchModelSettings()
      .then((r) => setModelSettings(r.models))
      .catch(() => {});
  }, []);

  async function handleRunSettingChange(value: boolean) {
    if (!currentProjectId) return;
    setUseLocalPlaywright(value);
    setRunSettingsSaving(true);
    try {
      await saveRunSettings(currentProjectId, { useLocalPlaywright: value });
    } catch {
      setUseLocalPlaywright(!value);
    } finally {
      setRunSettingsSaving(false);
    }
  }

  async function handleModelChange(key: string, value: string) {
    setModelSaving(key);
    setModelStatus("");
    try {
      // Empty string resets to default
      await saveModelSettings({ [key]: value });
      const r = await fetchModelSettings();
      setModelSettings(r.models);
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

  if (!currentProjectId || !currentProject) {
    return (
      <div className="flex flex-col min-h-full">
        <Header />
        <div className="flex items-center justify-center flex-1 text-[13px] text-muted-foreground">
          Select a project to view settings.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header />

      <div className="px-8 py-8 animate-fade-in max-w-xl space-y-8 mx-auto w-full">

        {/* Project name */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3 px-0.5">
            General
          </p>
          <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-[12px] font-medium text-foreground/80 mb-1.5 block">Project name</label>
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
                    disabled={nameSaving || !projectName.trim() || projectName.trim() === currentProject.name}
                    className="gap-1.5"
                  >
                    <Check className="h-3 w-3" />
                    {nameSaving ? "Saving…" : "Rename"}
                  </Button>
                </div>
                {nameStatus && (
                  <p className="text-[12px] text-muted-foreground mt-2">{nameStatus}</p>
                )}
              </div>
              <div>
                <label className="text-[12px] font-medium text-foreground/80 mb-1 block">Project ID</label>
                <p className="text-[12px] font-mono text-muted-foreground bg-muted/50 rounded-md px-3 py-2 border border-border select-all">
                  {currentProjectId}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Test runs */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3 px-0.5">
            Test runs
          </p>
          <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Use local Playwright</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    Run tests with a local Chromium instance. No cloud credentials required.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useLocalPlaywright}
                  disabled={runSettingsSaving}
                  onClick={() => handleRunSettingChange(!useLocalPlaywright)}
                  className={cn(
                    "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50",
                    useLocalPlaywright ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200",
                      useLocalPlaywright ? "translate-x-4" : "translate-x-0",
                    )}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Models */}
        <div>
          <div className="flex items-center justify-between mb-3 px-0.5">
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
          <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-5 py-4 space-y-4">
              {MODEL_CONFIG.map(({ key, label, description, options }) => {
                const setting = modelSettings[key];
                if (!setting) return null;
                return (
                  <ModelSelect
                    key={key}
                    modelKey={key}
                    label={label}
                    description={description}
                    options={options}
                    current={setting.current}
                    defaultValue={setting.default}
                    customized={setting.customized}
                    saving={modelSaving === key || modelSaving === "__all__"}
                    onChange={handleModelChange}
                  />
                );
              })}
              {modelStatus && (
                <p className="text-[12px] text-muted-foreground">{modelStatus}</p>
              )}
            </div>
          </div>
        </div>

        {/* Danger zone */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-destructive/60 mb-3 px-0.5">
            Danger zone
          </p>
          <div className="rounded-lg border border-destructive/30 bg-card shadow-sm overflow-hidden">
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-[13px] font-semibold text-foreground">Delete project</p>
                <p className="text-[12px] text-muted-foreground mt-0.5 mb-3">
                  This permanently deletes the project and all its environments, tests, runs, and memory. This action cannot be undone.
                </p>
                <label className="text-[12px] font-medium text-foreground/80 mb-1.5 block">
                  Type <span className="font-mono font-semibold text-foreground">"{currentProject.name}"</span> to confirm
                </label>
                <div className="flex gap-2">
                  <Input
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder={currentProject.name}
                    className="flex-1 border-destructive/30 focus:ring-destructive/30"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleting || deleteConfirm !== currentProject.name}
                    className="gap-1.5"
                  >
                    <Trash2 className="h-3 w-3" />
                    {deleting ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

function Header() {
  return (
    <div className="flex items-center gap-2 px-8 h-14 border-b border-border bg-card flex-shrink-0">
      <SettingsIcon className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-semibold text-foreground">Settings</span>
    </div>
  );
}

// ─── Model configuration ────────────────────────────────────────────────────

type ModelOption = { value: string; label: string; price?: string };

const AGENT_OPTIONS: ModelOption[] = [
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", price: "$0.10 / $0.40" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
];

const TEXT_OPTIONS: ModelOption[] = [
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", price: "$0.10 / $0.40" },
  { value: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", price: "$0.10 / $0.40" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.30 / $2.50" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", price: "$0.26 / $0.38" },
];

const VISION_OPTIONS: ModelOption[] = [
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", price: "$0.10 / $0.40" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.30 / $2.50" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
];

const REASONING_VISION_OPTIONS: ModelOption[] = [
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.30 / $2.50" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", price: "$1.00 / $5.00" },
];

const CODE_OPTIONS: ModelOption[] = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.30 / $2.50" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$3.00 / $15.00" },
  { value: "openai/gpt-4.1", label: "GPT-4.1", price: "$2.00 / $8.00" },
  { value: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", price: "$0.40 / $1.60" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", price: "$1.25 / $10.00" },
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", price: "$0.26 / $0.38" },
];

const STAGEHAND_OPTIONS: ModelOption[] = [
  { value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", price: "$0.10 / $0.40" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", price: "$0.30 / $2.50" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", price: "$0.15 / $0.60" },
  { value: "openai/gpt-4o", label: "GPT-4o", price: "$2.50 / $10.00" },
];

const MODEL_CONFIG: { key: string; label: string; description: string; options: ModelOption[] }[] = [
  {
    key: "agentModel",
    label: "Agent Model",
    description: "Browser automation decisions — needs fast tool calling",
    options: AGENT_OPTIONS,
  },
  {
    key: "summaryModel",
    label: "Summary Model",
    description: "Run summaries — cheap, text-only",
    options: TEXT_OPTIONS,
  },
  {
    key: "reviewModel",
    label: "Review Model",
    description: "Screenshot review — needs vision, cost-efficient",
    options: VISION_OPTIONS,
  },
  {
    key: "reviewAgentModel",
    label: "Review Agent Model",
    description: "Deep visual analysis — needs strong vision + reasoning",
    options: REASONING_VISION_OPTIONS,
  },
  {
    key: "scriptModel",
    label: "Script Model",
    description: "Playwright script & strategy generation",
    options: CODE_OPTIONS,
  },
  {
    key: "stagehandModel",
    label: "Stagehand Model",
    description: "Smart element finding via Stagehand",
    options: STAGEHAND_OPTIONS,
  },
];

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
}: {
  modelKey: string;
  label: string;
  description: string;
  options: ModelOption[];
  current: string;
  defaultValue: string;
  customized: boolean;
  saving: boolean;
  onChange: (key: string, value: string) => void;
}) {
  // Ensure current value is in the options list
  const allOptions = options.some((o) => o.value === current)
    ? options
    : [{ value: current, label: current }, ...options];

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[12px] font-medium text-foreground/80">{label}</label>
        {customized && (
          <button
            onClick={() => onChange(modelKey, "")}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Reset
          </button>
        )}
      </div>
      <div className="relative">
        <select
          value={current}
          onChange={(e) => onChange(modelKey, e.target.value)}
          disabled={saving}
          className={cn(
            "w-full h-9 rounded-md border border-border bg-background px-3 pr-8 text-[12px] text-foreground appearance-none",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            customized && "border-primary/40",
          )}
        >
          {allOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}{opt.price ? ` — ${opt.price}` : ""}{opt.value === defaultValue ? " (default)" : ""}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      </div>
      <p className="text-[11px] text-muted-foreground/60 mt-1">{description}</p>
    </div>
  );
}
