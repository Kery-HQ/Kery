import React from "react";
import {
  Brain,
  Trash,
  Plus,
  Pencil,
  Path,
  EyeSlash,
  ShieldWarning,
  Bug,
  Lightbulb,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
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
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import {
  fetchMemory, createMemoryEntry, updateMemoryEntry, deleteMemoryEntry, clearMemory,
  type MemoryEntry, type MemoryEntryType,
} from "@/projectApi";

const TYPES: {
  value: MemoryEntryType;
  label: string;
  description: string;
  icon: React.ReactNode;
  IconEl: Icon;
  badge: "success" | "default" | "neutral" | "warning" | "destructive";
  color: string;
  track: string;
}[] = [
  {
    value: "learned_path",
    label: "Learned Path",
    description: "Navigation sequences the agent has learned to use",
    icon: <Path className="h-3 w-3" />,
    IconEl: Path,
    badge: "success",
    color: "text-emerald-600 dark:text-emerald-400",
    track: "bg-emerald-500/20",
  },
  {
    value: "tip",
    label: "Tip",
    description: "Hints that sharpen how the agent reasons",
    icon: <Lightbulb className="h-3 w-3" />,
    IconEl: Lightbulb,
    badge: "default",
    color: "text-blue-600 dark:text-blue-400",
    track: "bg-blue-500/20",
  },
  {
    value: "ignore_region",
    label: "Ignore Region",
    description: "Areas to pass over without interacting",
    icon: <EyeSlash className="h-3 w-3" />,
    IconEl: EyeSlash,
    badge: "neutral",
    color: "text-slate-500 dark:text-slate-400",
    track: "bg-slate-400/20",
  },
  {
    value: "avoid_region",
    label: "Avoid Region",
    description: "Zones that caused failures — stay clear",
    icon: <ShieldWarning className="h-3 w-3" />,
    IconEl: ShieldWarning,
    badge: "warning",
    color: "text-orange-600 dark:text-orange-400",
    track: "bg-orange-500/20",
  },
  {
    value: "bug_pattern",
    label: "Bug Pattern",
    description: "Known failure signatures to detect and flag",
    icon: <Bug className="h-3 w-3" />,
    IconEl: Bug,
    badge: "destructive",
    color: "text-rose-600 dark:text-rose-400",
    track: "bg-rose-500/20",
  },
];

function typeInfo(type: MemoryEntryType) {
  return TYPES.find((t) => t.value === type) ?? TYPES[0];
}

export const Memory: React.FC = () => {
  const { currentProjectId } = useProject();
  const [entries, setEntries]         = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading]         = React.useState(false);

  const [addOpen, setAddOpen]         = React.useState(false);
  const [addType, setAddType]         = React.useState<MemoryEntryType>("tip");
  const [addSummary, setAddSummary]   = React.useState("");
  const [addContent, setAddContent]   = React.useState("");
  const [addSaving, setAddSaving]     = React.useState(false);

  const [editEntry, setEditEntry]     = React.useState<MemoryEntry | null>(null);
  const [editType, setEditType]       = React.useState<MemoryEntryType>("tip");
  const [editSummary, setEditSummary] = React.useState("");
  const [editContent, setEditContent] = React.useState("");
  const [editSaving, setEditSaving]   = React.useState(false);

  const [clearOpen, setClearOpen]     = React.useState(false);
  const [clearing, setClearing]       = React.useState(false);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchMemory(currentProjectId).catch(() => ({ entries: [] }));
    setEntries(res.entries || []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  async function handleClear() {
    if (!currentProjectId) return;
    setClearing(true);
    await clearMemory(currentProjectId);
    setEntries([]);
    setClearing(false);
    setClearOpen(false);
  }

  async function handleDelete(id: string) {
    if (!currentProjectId) return;
    await deleteMemoryEntry(currentProjectId, id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function handleAdd() {
    if (!currentProjectId || !addSummary.trim() || !addContent.trim()) return;
    setAddSaving(true);
    try {
      const res = await createMemoryEntry(currentProjectId, {
        type: addType, summary: addSummary.trim(), content: addContent.trim(),
      });
      if (res.entry) {
        setEntries((prev) => [res.entry, ...prev]);
        setAddOpen(false); setAddSummary(""); setAddContent(""); setAddType("tip");
      }
    } finally { setAddSaving(false); }
  }

  function openEdit(entry: MemoryEntry) {
    setEditEntry(entry); setEditType(entry.type);
    setEditSummary(entry.summary); setEditContent(entry.content);
  }

  async function handleEdit() {
    if (!currentProjectId || !editEntry) return;
    setEditSaving(true);
    try {
      const res = await updateMemoryEntry(currentProjectId, editEntry.id, {
        type: editType, summary: editSummary.trim(), content: editContent.trim(),
      });
      if (res.entry) {
        setEntries((prev) => prev.map((e) => (e.id === editEntry.id ? res.entry : e)));
        setEditEntry(null);
      }
    } finally { setEditSaving(false); }
  }

  function openAddForType(type: MemoryEntryType) {
    setAddType(type);
    setAddOpen(true);
  }

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Brain className="h-4 w-4" />} title="Memory" />
        <EmptyState icon={<Brain className="h-8 w-8" />} title="No project selected"
          description="Select a project to view memory." className="flex-1" />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        icon={<Brain className="h-4 w-4" />}
        title="Memory"
        description={entries.length > 0 ? `${entries.length} entries` : undefined}
      >
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><Plus className="h-3.5 w-3.5" />Add Entry</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Memory Entry</DialogTitle>
              <DialogDescription>Manually add a memory entry for the agent.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Type</label>
                <Select value={addType} onChange={(e) => setAddType(e.target.value as MemoryEntryType)}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Summary</label>
                <Input placeholder="Short title for this entry" value={addSummary}
                  onChange={(e) => setAddSummary(e.target.value)} autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Content</label>
                <Textarea placeholder="Detailed description, path steps, region info..."
                  value={addContent} onChange={(e) => setAddContent(e.target.value)}
                  rows={4} className="min-h-[80px]" />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
              <Button size="sm" onClick={handleAdd} loading={addSaving}
                disabled={!addSummary.trim() || !addContent.trim()}>Add Entry</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {entries.length > 0 && (
          <Dialog open={clearOpen} onOpenChange={setClearOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="ghost"
                className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10">
                <Trash className="h-3.5 w-3.5" />Clear All
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear All Memory</DialogTitle>
                <DialogDescription>
                  This will permanently delete all {entries.length} memory entries. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
                <Button variant="destructive" size="sm" onClick={handleClear} loading={clearing}>Clear All</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </PageHeader>

      {/* Edit dialog */}
      <Dialog open={!!editEntry} onOpenChange={(open) => !open && setEditEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Entry</DialogTitle>
            <DialogDescription>Update this memory entry.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Type</label>
              <Select value={editType} onChange={(e) => setEditType(e.target.value as MemoryEntryType)}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Summary</label>
              <Input value={editSummary} onChange={(e) => setEditSummary(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Content</label>
              <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)}
                rows={4} className="min-h-[80px]" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
            <Button size="sm" onClick={handleEdit} loading={editSaving}
              disabled={!editSummary.trim() || !editContent.trim()}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Kanban board */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        {loading ? (
          <div className="flex gap-4 px-5 py-5 h-full">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="w-[260px] flex-shrink-0 space-y-2">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-1 w-full rounded-full" />
                <Skeleton className="h-24 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-4 h-full px-5 py-5" style={{ minWidth: "max-content" }}>
            {TYPES.map((type) => {
              const col = entries.filter((e) => e.type === type.value);
              const TypeIcon = type.IconEl;
              return (
                <div key={type.value} className="w-[260px] flex-shrink-0 flex flex-col min-h-0">
                  {/* Column header */}
                  <div className="mb-2 flex-shrink-0">
                    <div className="flex items-center gap-2 mb-1">
                      <TypeIcon className={cn("h-3.5 w-3.5 flex-shrink-0", type.color)} />
                      <span className="text-[13px] font-semibold text-foreground leading-none">
                        {type.label}
                      </span>
                      <span className="ml-auto text-[11px] font-mono text-muted-foreground/50 tabular-nums">
                        {col.length}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/55 leading-snug pl-[22px]">
                      {type.description}
                    </p>
                  </div>

                  {/* Colored track */}
                  <div className={cn("h-[3px] rounded-full mb-3 flex-shrink-0", type.track)} />

                  {/* Cards */}
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-2">
                    {col.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => openAddForType(type.value)}
                        className="w-full rounded-lg border border-dashed border-border py-8 flex flex-col items-center gap-2 text-muted-foreground/40 hover:text-muted-foreground/70 hover:border-border/70 transition-colors"
                      >
                        <Plus className="h-4 w-4" />
                        <span className="text-[12px]">Add first entry</span>
                      </button>
                    ) : (
                      <>
                        {col.map((entry) => (
                          <Card key={entry.id}
                            className="group transition-colors hover:border-border/80 cursor-pointer"
                            onClick={() => openEdit(entry)}>
                            <CardContent className="p-3">
                              <p className="text-[13px] font-medium text-foreground leading-snug mb-1.5">
                                {entry.summary}
                              </p>
                              <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-3">
                                {entry.content}
                              </p>
                              <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-border">
                                <Badge variant={type.badge} className="gap-1 text-[10px] h-5 pointer-events-none">
                                  {type.icon}{entry.source}
                                </Badge>
                                <span className="ml-auto text-[11px] font-mono text-muted-foreground/40 tabular-nums">
                                  {entry.confidence}%
                                </span>
                                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Button size="icon-sm" variant="ghost" className="h-6 w-6"
                                    onClick={(e) => { e.stopPropagation(); openEdit(entry); }}>
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button size="icon-sm" variant="ghost"
                                    className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={(e) => { e.stopPropagation(); handleDelete(entry.id); }}>
                                    <Trash className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                        <button
                          type="button"
                          onClick={() => openAddForType(type.value)}
                          className="w-full rounded-lg border border-dashed border-border py-3 flex items-center justify-center gap-1.5 text-muted-foreground/40 hover:text-muted-foreground/70 hover:border-border/70 transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span className="text-[12px]">Add entry</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
