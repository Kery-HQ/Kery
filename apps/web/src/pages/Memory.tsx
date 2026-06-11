import React from "react";
import {
  Brain, Plus, Trash, CaretDown, MagnifyingGlass, X,
  Path, EyeSlash, ShieldWarning, Bug, Lightbulb,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/formatters";
import { useProject } from "@/lib/projectContext";
import {
  fetchMemory, createMemoryEntry, updateMemoryEntry, deleteMemoryEntry, clearMemory,
  type MemoryEntry, type MemoryEntryType,
} from "@/projectApi";

// ─── Type config ─────────────────────────────────────────────────────────────

type TypeDef = {
  value: MemoryEntryType;
  label: string;
  IconEl: Icon;
  textColor: string;
};

const TYPES: TypeDef[] = [
  { value: "learned_path", label: "Learned Path", IconEl: Path,          textColor: "text-emerald-600 dark:text-emerald-400" },
  { value: "tip",          label: "Tip",           IconEl: Lightbulb,     textColor: "text-blue-600 dark:text-blue-400"    },
  { value: "ignore_region",label: "Ignore Region", IconEl: EyeSlash,      textColor: "text-slate-500 dark:text-slate-400"  },
  { value: "avoid_region", label: "Avoid Region",  IconEl: ShieldWarning, textColor: "text-orange-600 dark:text-orange-400"},
  { value: "bug_pattern",  label: "Bug Pattern",   IconEl: Bug,           textColor: "text-rose-600 dark:text-rose-400"   },
];

function getType(v: MemoryEntryType): TypeDef {
  return TYPES.find(t => t.value === v) ?? TYPES[0];
}

// ─── Main component ───────────────────────────────────────────────────────────

export const Memory: React.FC = () => {
  const { currentProjectId } = useProject();
  const [entries, setEntries]   = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading]   = React.useState(false);

  const [search, setSearch]     = React.useState("");
  const [openSections, setOpenSections] = React.useState<Set<string>>(
    () => new Set(TYPES.map(t => t.value)),
  );
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Add dialog
  const [addOpen, setAddOpen]       = React.useState(false);
  const [addType, setAddType]       = React.useState<MemoryEntryType>("tip");
  const [addSummary, setAddSummary] = React.useState("");
  const [addContent, setAddContent] = React.useState("");
  const [addSaving, setAddSaving]   = React.useState(false);

  // Clear dialog
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearing, setClearing]   = React.useState(false);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchMemory(currentProjectId).catch(() => ({ entries: [] }));
    setEntries(res.entries ?? []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  const entriesByType = React.useMemo(() => {
    const map: Record<string, MemoryEntry[]> = {};
    for (const t of TYPES) map[t.value] = [];
    for (const e of entries) { if (map[e.type]) map[e.type].push(e); }
    return map;
  }, [entries]);

  // Per-type list after search filter
  const filteredByType = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const map: Record<string, MemoryEntry[]> = {};
    for (const t of TYPES) {
      const list = entriesByType[t.value] ?? [];
      map[t.value] = q
        ? list.filter(e => e.summary.toLowerCase().includes(q) || e.content.toLowerCase().includes(q))
        : list;
    }
    return map;
  }, [entriesByType, search]);

  // Auto-expand sections that have results when searching
  React.useEffect(() => {
    if (search.trim()) {
      setOpenSections(new Set(
        TYPES.filter(t => (filteredByType[t.value]?.length ?? 0) > 0).map(t => t.value),
      ));
    }
  }, [search, filteredByType]);

  function toggleSection(type: string) {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  function toggleEntry(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  function openAddDialog(type?: MemoryEntryType) {
    setAddType(type ?? "tip");
    setAddSummary(""); setAddContent("");
    setAddOpen(true);
  }

  async function handleAdd() {
    if (!currentProjectId || !addSummary.trim() || !addContent.trim()) return;
    setAddSaving(true);
    try {
      const res = await createMemoryEntry(currentProjectId, {
        type: addType, summary: addSummary.trim(), content: addContent.trim(),
      });
      if (res.entry) {
        setEntries(prev => [res.entry, ...prev]);
        setAddOpen(false);
        setOpenSections(prev => new Set([...prev, res.entry.type]));
        setExpandedId(res.entry.id);
      }
    } finally { setAddSaving(false); }
  }

  async function handleSaveEntry(
    id: string,
    data: { summary: string; content: string; type: MemoryEntryType },
  ) {
    if (!currentProjectId) return;
    const res = await updateMemoryEntry(currentProjectId, id, data);
    if (res.entry) setEntries(prev => prev.map(e => e.id === id ? res.entry : e));
  }

  async function handleDeleteEntry(id: string) {
    if (!currentProjectId) return;
    await deleteMemoryEntry(currentProjectId, id);
    setEntries(prev => prev.filter(e => e.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function handleClear() {
    if (!currentProjectId) return;
    setClearing(true);
    await clearMemory(currentProjectId);
    setEntries([]); setExpandedId(null);
    setClearing(false); setClearOpen(false);
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

  const searchActive    = search.trim().length > 0;
  const totalFiltered   = TYPES.reduce((n, t) => n + (filteredByType[t.value]?.length ?? 0), 0);

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <PageHeader
        icon={<Brain className="h-4 w-4" />}
        title="Memory"
        description={entries.length > 0 ? `${entries.length} entries` : undefined}
      >
        <Button size="sm" className="gap-1.5" onClick={() => openAddDialog()}>
          <Plus className="h-3.5 w-3.5" />Add Entry
        </Button>
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
                  Permanently delete all {entries.length} entries. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
                <Button variant="destructive" size="sm" onClick={handleClear} loading={clearing}>
                  Clear All
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </PageHeader>

      {/* Search bar */}
      <div className="flex items-center gap-3 px-6 py-2.5 border-b border-border flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
          <Input
            className="pl-8 h-7 text-[12px]"
            placeholder="Search memories…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {searchActive && (
          <span className="text-[11px] text-muted-foreground/40 flex-shrink-0">
            {totalFiltered === 0 ? "No results" : `${totalFiltered} result${totalFiltered !== 1 ? "s" : ""}`}
          </span>
        )}
      </div>

      {/* Accordion */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <MemorySkeleton />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Brain className="h-8 w-8" />}
            title="No memories yet"
            description="The agent builds memories as it runs. You can also add them manually."
            action={{ label: "Add Entry", onClick: () => openAddDialog() }}
            className="flex-1"
          />
        ) : (
          <div className="divide-y divide-border/60">
            {TYPES.map(type => {
              const all      = entriesByType[type.value] ?? [];
              const filtered = filteredByType[type.value] ?? [];
              const isOpen   = openSections.has(type.value);
              const TypeIcon = type.IconEl;

              if (searchActive && filtered.length === 0) return null;

              return (
                <div key={type.value}>
                  {/* Section header */}
                  <div className="flex items-center gap-0 group">
                    <button
                      onClick={() => toggleSection(type.value)}
                      className="flex items-center gap-2.5 flex-1 min-w-0 px-6 py-3 text-left hover:bg-muted/20 transition-colors"
                    >
                      <CaretDown
                        className={cn(
                          "h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0 transition-transform duration-150",
                          !isOpen && "-rotate-90",
                        )}
                      />
                      <TypeIcon className={cn("h-3.5 w-3.5 flex-shrink-0", type.textColor)} />
                      <span className="text-[13px] font-medium text-foreground">{type.label}</span>
                      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/35 ml-1">
                        {searchActive ? `${filtered.length} / ${all.length}` : all.length}
                      </span>
                    </button>

                    {/* Per-section Add — reveals on row hover */}
                    <button
                      onClick={() => openAddDialog(type.value)}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground/30 hover:text-muted-foreground mr-4 px-2 py-1 rounded hover:bg-muted/40 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    >
                      <Plus className="h-3 w-3" />Add
                    </button>
                  </div>

                  {/* Entries */}
                  {isOpen && (
                    <div>
                      {filtered.length === 0 ? (
                        <button
                          onClick={() => openAddDialog(type.value)}
                          className="w-full flex items-center gap-2 pl-[52px] pr-6 py-5 text-[12px] text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors text-left"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add first {type.label.toLowerCase()} entry
                        </button>
                      ) : (
                        filtered.map(entry => (
                          <EntryRow
                            key={entry.id}
                            entry={entry}
                            typeDef={type}
                            expanded={expandedId === entry.id}
                            onToggle={() => toggleEntry(entry.id)}
                            onSave={handleSaveEntry}
                            onDelete={handleDeleteEntry}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Entry dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Memory Entry</DialogTitle>
            <DialogDescription>Manually add a memory entry for the agent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Type</label>
              <Select value={addType} onChange={e => setAddType(e.target.value as MemoryEntryType)}>
                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Summary</label>
              <Input placeholder="Short title for this entry" value={addSummary}
                onChange={e => setAddSummary(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Content</label>
              <Textarea placeholder="Detailed description, path steps, region info..."
                value={addContent} onChange={e => setAddContent(e.target.value)}
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
    </div>
  );
};

// ─── Entry row ────────────────────────────────────────────────────────────────

type EntryRowProps = {
  entry: MemoryEntry;
  typeDef: TypeDef;
  expanded: boolean;
  onToggle: () => void;
  onSave: (id: string, data: { summary: string; content: string; type: MemoryEntryType }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

function EntryRow({ entry, typeDef, expanded, onToggle, onSave, onDelete }: EntryRowProps) {
  const [editSummary, setEditSummary] = React.useState(entry.summary);
  const [editContent, setEditContent] = React.useState(entry.content);
  const [editType, setEditType]       = React.useState<MemoryEntryType>(entry.type);
  const [dirty, setDirty]             = React.useState(false);
  const [saving, setSaving]           = React.useState(false);

  // Sync after external save
  React.useEffect(() => {
    setEditSummary(entry.summary);
    setEditContent(entry.content);
    setEditType(entry.type);
    setDirty(false);
  }, [entry.summary, entry.content, entry.type]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(entry.id, {
        summary: editSummary.trim(),
        content: editContent.trim(),
        type: editType,
      });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setEditSummary(entry.summary);
    setEditContent(entry.content);
    setEditType(entry.type);
    setDirty(false);
  }

  return (
    <div className="border-t border-border/40">
      {/* Collapsed row */}
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 pl-[52px] pr-6 py-2.5 text-left transition-colors",
          expanded ? "bg-muted/20" : "hover:bg-muted/15",
        )}
      >
        <span className="flex-1 min-w-0 text-[12px] text-foreground truncate">
          {entry.summary}
        </span>

        {/* Confidence bar */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="w-14 h-[3px] rounded-full bg-border overflow-hidden">
            <div className="h-full rounded-full bg-foreground/25" style={{ width: `${entry.confidence}%` }} />
          </div>
          <span className="text-[10px] font-mono tabular-nums text-muted-foreground/35 w-[30px] text-right">
            {entry.confidence}%
          </span>
        </div>

        <span className="text-[10px] text-muted-foreground/30 w-10 text-center flex-shrink-0 font-mono">
          {entry.source}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/25 w-8 text-right flex-shrink-0">
          {relativeTime(entry.created_at)}
        </span>

        <CaretDown className={cn(
          "h-3 w-3 text-muted-foreground/25 flex-shrink-0 transition-transform duration-150",
          !expanded && "-rotate-90",
        )} />
      </button>

      {/* Expanded edit panel */}
      {expanded && (
        <div className="pl-[52px] pr-6 pt-3 pb-4 border-t border-border/40 bg-muted/10 space-y-3">
          <div className="flex gap-3">
            <div className="w-44 flex-shrink-0">
              <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">
                Type
              </label>
              <Select value={editType} onChange={e => { setEditType(e.target.value as MemoryEntryType); setDirty(true); }}>
                {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">
              Summary
            </label>
            <Input
              value={editSummary}
              onChange={e => { setEditSummary(e.target.value); setDirty(true); }}
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">
              Content
            </label>
            <Textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setDirty(true); }}
              rows={4}
              className="min-h-[80px] resize-y"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleSave} loading={saving}
              disabled={!dirty || !editSummary.trim() || !editContent.trim()}>
              Save Changes
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={handleDiscard}>
                Discard
              </Button>
            )}
            <Button
              size="sm" variant="ghost"
              className="ml-auto gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(entry.id)}
            >
              <Trash className="h-3.5 w-3.5" />Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function MemorySkeleton() {
  return (
    <div className="divide-y divide-border/60">
      {TYPES.map((t, i) => (
        <div key={t.value} className="px-6 py-3">
          <div className="flex items-center gap-2.5 mb-3">
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3.5 w-28 rounded" />
          </div>
          <div className="pl-[30px] space-y-2">
            {Array.from({ length: i === 0 ? 3 : i === 1 ? 2 : 1 }).map((_, j) => (
              <Skeleton key={j} className="h-8 w-full rounded" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
