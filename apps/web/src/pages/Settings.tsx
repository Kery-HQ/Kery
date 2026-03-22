import React from "react";
import { Settings as SettingsIcon, Trash2, Check } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useProject } from "../lib/projectContext";
import { updateProject, deleteProject, fetchRunSettings, saveRunSettings } from "../projectApi";
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
                    Run tests with a local Chromium instance instead of BrowserStack. No cloud credentials required.
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
