import React from "react";
import {
  Brain, Trash2, RefreshCw, Plus, Pencil, Check, X,
  Route, EyeOff, ShieldAlert, Bug, Lightbulb,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useProject } from "../lib/projectContext";
import {
  fetchMemory, createMemoryEntry, updateMemoryEntry, deleteMemoryEntry, clearMemory,
  type MemoryEntry, type MemoryEntryType,
} from "../projectApi";

const TYPES: { value: MemoryEntryType; label: string; icon: React.ReactNode; color: string }[] = [
  { value: "learned_path",  label: "Learned Path",  icon: <Route className="h-3.5 w-3.5" />,       color: "text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900/30" },
  { value: "tip",           label: "Tip",            icon: <Lightbulb className="h-3.5 w-3.5" />,   color: "text-blue-600 bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-900/30" },
  { value: "ignore_region", label: "Ignore Region",  icon: <EyeOff className="h-3.5 w-3.5" />,      color: "text-gray-600 bg-gray-50 border-gray-200 dark:bg-gray-950/20 dark:border-gray-800/30" },
  { value: "avoid_region",  label: "Avoid Region",   icon: <ShieldAlert className="h-3.5 w-3.5" />, color: "text-orange-600 bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-900/30" },
  { value: "bug_pattern",   label: "Bug Pattern",    icon: <Bug className="h-3.5 w-3.5" />,         color: "text-red-600 bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900/30" },
];

function typeInfo(type: MemoryEntryType) {
  return TYPES.find((t) => t.value === type) ?? TYPES[0];
}

export const Memory: React.FC = () => {
  const { currentProjectId } = useProject();
  const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);

  async function load() {
    if (!currentProjectId) return;
    setLoading(true);
    const res = await fetchMemory(currentProjectId).catch(() => ({ entries: [] }));
    setEntries(res.entries || []);
    setLoading(false);
  }

  React.useEffect(() => { load(); }, [currentProjectId]);

  async function handleClear() {
    if (!currentProjectId || !confirm("Clear all project memory? This cannot be undone.")) return;
    setClearing(true);
    await clearMemory(currentProjectId);
    setEntries([]);
    setClearing(false);
  }

  async function handleDelete(id: string) {
    if (!currentProjectId) return;
    await deleteMemoryEntry(currentProjectId, id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function handleAdd(entry: { type: MemoryEntryType; summary: string; content: string }) {
    if (!currentProjectId) return;
    const res = await createMemoryEntry(currentProjectId, entry);
    if (res.entry) {
      setEntries((prev) => [res.entry, ...prev]);
      setShowAdd(false);
    }
  }

  async function handleUpdate(id: string, patch: Partial<Pick<MemoryEntry, "summary" | "content" | "type" | "confidence">>) {
    if (!currentProjectId) return;
    const res = await updateMemoryEntry(currentProjectId, id, patch);
    if (res.entry) {
      setEntries((prev) => prev.map((e) => (e.id === id ? res.entry : e)));
    }
  }

  const grouped = React.useMemo(() => {
    const map = new Map<MemoryEntryType, MemoryEntry[]>();
    for (const e of entries) {
      const arr = map.get(e.type) ?? [];
      arr.push(e);
      map.set(e.type, arr);
    }
    return map;
  }, [entries]);

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 h-14 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Memory</span>
          {entries.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground ml-1">{entries.length} entries</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1.5 h-8">
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
          <Button size="sm" variant="outline" onClick={load} className="gap-1.5 h-8">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          {entries.length > 0 && (
            <Button
              size="sm" variant="ghost"
              onClick={handleClear}
              disabled={clearing}
              className="gap-1.5 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </Button>
          )}
        </div>
      </div>

      <div className="px-8 py-6 animate-fade-in max-w-4xl w-full mx-auto">

        {showAdd && (
          <AddEntryForm onSave={handleAdd} onCancel={() => setShowAdd(false)} />
        )}

        {!currentProjectId ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Brain className="h-7 w-7 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] text-muted-foreground">Select a project to view memory.</p>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-12 rounded-lg border border-border animate-pulse" />)}
          </div>
        ) : entries.length === 0 && !showAdd ? (
          <div className="flex flex-col items-center justify-center py-24 text-center rounded-lg border border-dashed border-border">
            <Brain className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-semibold text-foreground">No memory yet</p>
            <p className="text-[13px] text-muted-foreground mt-1 max-w-sm">
              The agent learns paths, tips, and patterns as it runs tests. You can also add entries manually.
            </p>
            <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5" /> Add memory
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {TYPES.map((t) => {
              const items = grouped.get(t.value);
              if (!items || items.length === 0) return null;
              return (
                <div key={t.value}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cn("flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest px-2 py-1 rounded border", t.color)}>
                      {t.icon}
                      {t.label}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground/50">{items.length}</span>
                  </div>
                  <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden divide-y divide-border">
                    {items.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        onDelete={() => handleDelete(entry.id)}
                        onUpdate={(patch) => handleUpdate(entry.id, patch)}
                      />
                    ))}
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

function EntryRow({
  entry,
  onDelete,
  onUpdate,
}: {
  entry: MemoryEntry;
  onDelete: () => void;
  onUpdate: (patch: Partial<Pick<MemoryEntry, "summary" | "content">>) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [summary, setSummary] = React.useState(entry.summary);
  const [content, setContent] = React.useState(entry.content);

  function save() {
    onUpdate({ summary, content });
    setEditing(false);
  }

  function cancel() {
    setSummary(entry.summary);
    setContent(entry.content);
    setEditing(false);
  }

  return (
    <div className="px-4 py-3 group hover:bg-accent/30 transition-colors">
      {editing ? (
        <div className="space-y-2">
          <input
            className="w-full text-[13px] font-medium bg-transparent border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            autoFocus
          />
          <textarea
            className="w-full text-[12px] bg-transparent border border-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px]"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={save}>
              <Check className="h-3 w-3" /> Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]" onClick={cancel}>
              <X className="h-3 w-3" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-foreground">{entry.summary}</p>
            <p className="text-[12px] text-muted-foreground mt-0.5 whitespace-pre-wrap">{entry.content}</p>
            {entry.region?.description && (
              <p className="text-[11px] text-muted-foreground/60 mt-1 italic">Region: {entry.region.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded border",
              entry.source === "agent"
                ? "text-violet-600 bg-violet-50 border-violet-200 dark:bg-violet-950/20 dark:border-violet-900/30"
                : "text-sky-600 bg-sky-50 border-sky-200 dark:bg-sky-950/20 dark:border-sky-900/30",
            )}>
              {entry.source}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground/50 tabular-nums w-8 text-right">
              {entry.confidence}%
            </span>
            <button
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/40 hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/40 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddEntryForm({
  onSave,
  onCancel,
}: {
  onSave: (entry: { type: MemoryEntryType; summary: string; content: string }) => void;
  onCancel: () => void;
}) {
  const [type, setType] = React.useState<MemoryEntryType>("tip");
  const [summary, setSummary] = React.useState("");
  const [content, setContent] = React.useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!summary.trim() || !content.trim()) return;
    onSave({ type, summary: summary.trim(), content: content.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-primary/30 bg-card p-4 mb-6 space-y-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Add memory entry</p>
      <div className="flex gap-2 flex-wrap">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            className={cn(
              "flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded border transition-colors",
              type === t.value ? t.color : "text-muted-foreground border-border hover:bg-accent/40",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <input
        className="w-full text-[13px] font-medium bg-transparent border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder="Summary (short title)"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        autoFocus
      />
      <textarea
        className="w-full text-[12px] bg-transparent border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px]"
        placeholder="Content (detailed description, path steps, region info...)"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" type="submit" className="h-8 gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
        <Button size="sm" variant="ghost" type="button" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
