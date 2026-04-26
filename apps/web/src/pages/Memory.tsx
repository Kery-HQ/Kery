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

const TYPES: { value: MemoryEntryType; label: string; icon: React.ReactNode; badge: "success" | "default" | "neutral" | "warning" | "destructive" }[] = [
  { value: "learned_path",  label: "Learned Path",  icon: <Path className="h-3 w-3" />,       badge: "success" },
  { value: "tip",           label: "Tip",            icon: <Lightbulb className="h-3 w-3" />,   badge: "default" },
  { value: "ignore_region", label: "Ignore Region",  icon: <EyeSlash className="h-3 w-3" />,      badge: "neutral" },
  { value: "avoid_region",  label: "Avoid Region",   icon: <ShieldWarning className="h-3 w-3" />, badge: "warning" },
  { value: "bug_pattern",   label: "Bug Pattern",    icon: <Bug className="h-3 w-3" />,         badge: "destructive" },
];

function typeInfo(type: MemoryEntryType) {
  return TYPES.find((t) => t.value === type) ?? TYPES[0];
}

type FilterType = MemoryEntryType | "all";

export const Memory: React.FC = () => {
  const { currentProjectId } = useProject();
  const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState<FilterType>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Add dialog
  const [addOpen, setAddOpen] = React.useState(false);
  const [addType, setAddType] = React.useState<MemoryEntryType>("tip");
  const [addSummary, setAddSummary] = React.useState("");
  const [addContent, setAddContent] = React.useState("");
  const [addSaving, setAddSaving] = React.useState(false);

  // Edit dialog
  const [editEntry, setEditEntry] = React.useState<MemoryEntry | null>(null);
  const [editType, setEditType] = React.useState<MemoryEntryType>("tip");
  const [editSummary, setEditSummary] = React.useState("");
  const [editContent, setEditContent] = React.useState("");
  const [editSaving, setEditSaving] = React.useState(false);

  // Clear all dialog
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

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
        type: addType,
        summary: addSummary.trim(),
        content: addContent.trim(),
      });
      if (res.entry) {
        setEntries((prev) => [res.entry, ...prev]);
        setAddOpen(false);
        setAddSummary("");
        setAddContent("");
        setAddType("tip");
      }
    } finally {
      setAddSaving(false);
    }
  }

  function openEdit(entry: MemoryEntry) {
    setEditEntry(entry);
    setEditType(entry.type);
    setEditSummary(entry.summary);
    setEditContent(entry.content);
  }

  async function handleEdit() {
    if (!currentProjectId || !editEntry) return;
    setEditSaving(true);
    try {
      const res = await updateMemoryEntry(currentProjectId, editEntry.id, {
        type: editType,
        summary: editSummary.trim(),
        content: editContent.trim(),
      });
      if (res.entry) {
        setEntries((prev) => prev.map((e) => (e.id === editEntry.id ? res.entry : e)));
        setEditEntry(null);
      }
    } finally {
      setEditSaving(false);
    }
  }

  const filtered = React.useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.type === filter);
  }, [entries, filter]);

  React.useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((e) => e.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selectedEntry = React.useMemo(
    () => filtered.find((e) => e.id === selectedId) ?? null,
    [filtered, selectedId]
  );

  if (!currentProjectId) {
    return (
      <div className="flex flex-col min-h-full">
        <PageHeader icon={<Brain className="h-4 w-4" />} title="Memory" />
        <EmptyState
          icon={<Brain className="h-8 w-8" />}
          title="No project selected"
          description="Select a project to view memory."
          className="flex-1"
        />
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
            <Button size="sm" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Entry
            </Button>
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
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Summary</label>
                <Input
                  placeholder="Short title for this entry"
                  value={addSummary}
                  onChange={(e) => setAddSummary(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Content</label>
                <Textarea
                  placeholder="Detailed description, path steps, region info..."
                  value={addContent}
                  onChange={(e) => setAddContent(e.target.value)}
                  rows={4}
                  className="min-h-[80px]"
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                size="sm"
                onClick={handleAdd}
                loading={addSaving}
                disabled={!addSummary.trim() || !addContent.trim()}
              >
                Add Entry
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {entries.length > 0 && (
          <Dialog open={clearOpen} onOpenChange={setClearOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10">
                <Trash className="h-3.5 w-3.5" />
                Clear All
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
                <DialogClose asChild>
                  <Button variant="ghost" size="sm">Cancel</Button>
                </DialogClose>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleClear}
                  loading={clearing}
                >
                  Clear All
                </Button>
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
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Summary</label>
              <Input
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Content</label>
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={4}
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleEdit}
              loading={editSaving}
              disabled={!editSummary.trim() || !editContent.trim()}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex-1 min-h-0 overflow-hidden animate-fade-in">
        {loading ? (
          <div className="px-6 py-5 space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-5">
            <EmptyState
              icon={<Brain className="h-8 w-8" />}
              title={filter === "all" ? "No memory yet" : `No ${typeInfo(filter as MemoryEntryType).label.toLowerCase()} entries`}
              description={
                filter === "all"
                  ? "The agent learns paths, tips, and patterns as it runs tests. You can also add entries manually."
                  : "No entries match this filter."
              }
              action={filter === "all" ? { label: "Add entry", onClick: () => setAddOpen(true) } : undefined}
              className="py-20 rounded-lg border border-dashed border-border"
            />
          </div>
        ) : (
          <div className="flex h-full min-h-0 overflow-hidden">
            <div className="w-[360px] flex-shrink-0 flex flex-col min-h-0 border-r border-border overflow-hidden">
              <div className="px-3 py-2 border-b border-border bg-surface-2 dark:bg-surface-3">
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as FilterType)}
                  className="h-8 text-[12px]"
                >
                  <option value="all">All types</option>
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
                {filtered.map((entry) => {
                  const info = typeInfo(entry.type);
                  const selected = entry.id === selectedId;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className="w-full text-left block"
                    >
                      <Card className={cn("transition-all", selected && "ring-2 ring-ring/20 border-border bg-accent/25")}>
                        <CardContent className="py-2.5 px-3">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={info.badge} className="gap-1">
                              {info.icon}
                              {info.label}
                            </Badge>
                          </div>
                          <p className="text-[13px] font-medium text-foreground line-clamp-1">{entry.summary}</p>
                          <p className="text-[12px] text-muted-foreground mt-0.5 line-clamp-2">{entry.content}</p>
                        </CardContent>
                      </Card>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
              {selectedEntry ? (
                <>
                  <div className="flex-shrink-0 border-b border-border px-5 py-3 bg-surface-2 dark:bg-surface-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={typeInfo(selectedEntry.type).badge} className="gap-1">
                            {typeInfo(selectedEntry.type).icon}
                            {typeInfo(selectedEntry.type).label}
                          </Badge>
                          <Badge variant={selectedEntry.source === "agent" ? "outline" : "neutral"}>
                            {selectedEntry.source}
                          </Badge>
                          <span className="text-[11px] font-mono text-muted-foreground/60 tabular-nums">
                            {selectedEntry.confidence}%
                          </span>
                        </div>
                        <h2 className="text-[15px] font-semibold text-foreground leading-snug truncate min-w-0">
                          {selectedEntry.summary}
                        </h2>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 text-[12px] gap-1.5"
                          onClick={() => openEdit(selectedEntry)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 text-[12px] text-destructive border-destructive/30 hover:bg-destructive/10"
                          onClick={() => handleDelete(selectedEntry.id)}
                        >
                          <Trash className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
                    <section>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55 mb-2">
                        Content
                      </p>
                      <p className="text-[13px] text-foreground whitespace-pre-wrap leading-relaxed">
                        {selectedEntry.content}
                      </p>
                    </section>
                    {selectedEntry.region?.description && (
                      <section className="border-t border-border pt-4">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55 mb-2">
                          Region
                        </p>
                        <p className="text-[12px] text-muted-foreground italic">
                          {selectedEntry.region.description}
                        </p>
                      </section>
                    )}
                  </div>
                </>
              ) : (
                <div className="p-6">
                  <EmptyState
                    icon={<Brain className="h-8 w-8" />}
                    title="Select an entry"
                    description="Choose a memory entry from the sidebar to view details."
                    className="py-16"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
