import React from "react";
import { useNavigate } from "react-router-dom";
import { Gear, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { useProject } from "@/lib/projectContext";
import { updateProject, deleteProject } from "@/projectApi";
import { cn } from "@/lib/utils";

export const ProjectSettings: React.FC = () => {
  const navigate = useNavigate();
  const { currentProjectId, currentProject, refreshProjects, setCurrentProjectId, projects } = useProject();

  const [projectName, setProjectName] = React.useState("");
  const [projectDomain, setProjectDomain] = React.useState("");
  const [nameSaving, setNameSaving] = React.useState(false);
  const [nameStatus, setNameStatus] = React.useState("");

  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  React.useEffect(() => {
    setProjectName(currentProject?.name ?? "");
    setProjectDomain(currentProject?.domain ?? "");
    setNameStatus("");
    setDeleteConfirm("");
  }, [currentProject?.id]);

  async function handleSaveProject() {
    if (!currentProjectId) return;
    const nextName = projectName.trim();
    const nextDomain = projectDomain.trim();
    const hasNameChange = !!nextName && nextName !== currentProject?.name;
    const hasDomainChange = (nextDomain || null) !== (currentProject?.domain || null);
    if (!hasNameChange && !hasDomainChange) return;
    setNameSaving(true);
    try {
      await updateProject(currentProjectId, {
        ...(hasNameChange ? { name: nextName } : {}),
        ...(hasDomainChange ? { domain: nextDomain || null } : {}),
      });
      await refreshProjects();
      setNameStatus("Project settings updated.");
    } catch {
      setNameStatus("Failed to update project settings.");
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
    if (next) setCurrentProjectId(next.id);
    navigate("/overview");
  }

  if (!currentProjectId || !currentProject) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Gear className="h-4 w-4" />} title="Project Settings" />
        <EmptyState
          icon={<Gear className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view project settings."
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Gear className="h-4 w-4" />}
        title="Project Settings"
        description="Project identity, base URL, and destructive actions."
      />

      <div className="px-6 py-5 animate-fade-in max-w-3xl space-y-6 mx-auto w-full">
        <section>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">Project settings</p>
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Project name</label>
                <p className="text-[11px] text-muted-foreground/70 mb-2">
                  Shown across the app and in run reports.
                </p>
                <Input
                  value={projectName}
                  onChange={(e) => { setProjectName(e.target.value); setNameStatus(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveProject()}
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Base URL</label>
                <p className="text-[11px] text-muted-foreground/70 mb-2">
                  Used for project icon/domain context. Leave blank if not needed.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={projectDomain}
                    onChange={(e) => { setProjectDomain(e.target.value); setNameStatus(""); }}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveProject()}
                    placeholder="example.com"
                    className="mono-ui"
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveProject}
                    loading={nameSaving}
                    disabled={
                      (!projectName.trim() || projectName.trim() === currentProject.name)
                      && ((projectDomain.trim() || null) === (currentProject.domain || null))
                    }
                  >
                    Save
                  </Button>
                </div>
                {nameStatus && (
                  <p className={cn("text-[12px] mt-1.5", nameStatus.includes("Failed") ? "text-destructive" : "text-status-pass")}>
                    {nameStatus}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-destructive/60 mb-3">Danger zone</p>
          <Card className="border-destructive/30">
            <CardContent className="pt-4">
              <p className="text-[13px] font-semibold text-foreground">Delete project</p>
              <p className="text-[12px] text-muted-foreground mt-0.5 mb-3">
                This permanently deletes the project and all its environments, tests, runs, and memory. This cannot be undone.
              </p>
              <Dialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteConfirm(""); }}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="gap-1.5">
                    <Trash className="h-3 w-3" />
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
                      Type <span className="mono-ui font-semibold text-foreground">"{currentProject.name}"</span> to confirm
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

