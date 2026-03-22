import { logger } from "./logger.js";
import type { StorageAdapter } from "./storage.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryEntryType = "learned_path" | "ignore_region" | "avoid_region" | "bug_pattern" | "tip";
export type MemorySource = "agent" | "user";

export type MemoryEntry = {
  id: string;
  scope: "project" | "page";
  project_id: string | null;
  destination_id: string | null;
  type: MemoryEntryType;
  summary: string;
  content: string;
  region?: { description: string } | null;
  source: MemorySource;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export type MemoryEntryInsert = {
  type: MemoryEntryType;
  summary: string;
  content: string;
  region?: { description: string } | null;
  source?: MemorySource;
  confidence?: number;
};

// ─── Load (via StorageAdapter) ──────────────────────────────────────────────

export async function loadProjectMemory(storage: StorageAdapter, projectId: string): Promise<MemoryEntry[]> {
  try {
    return await storage.loadProjectMemory(projectId);
  } catch {
    return [];
  }
}

export async function loadPageMemory(storage: StorageAdapter, destinationId: string): Promise<MemoryEntry[]> {
  try {
    return await storage.loadPageMemory(destinationId);
  } catch {
    return [];
  }
}

// ─── Save (via StorageAdapter) ──────────────────────────────────────────────

export async function saveProjectMemoryEntries(
  storage: StorageAdapter,
  projectId: string,
  entries: MemoryEntryInsert[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await storage.saveProjectMemoryEntries(projectId, entries);
    logger.info({ projectId, count: entries.length }, "Saved project memory entries");
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to save project memory entries");
  }
}

export async function savePageMemoryEntries(
  storage: StorageAdapter,
  destinationId: string,
  entries: MemoryEntryInsert[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await storage.savePageMemoryEntries(destinationId, entries);
    logger.info({ destinationId, count: entries.length }, "Saved page memory entries");
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to save page memory entries");
  }
}

// ─── Boost confidence ─────────────────────────────────────────────────────────

export async function boostConfidence(storage: StorageAdapter, ids: string[], amount = 5): Promise<void> {
  if (ids.length === 0) return;
  await storage.boostConfidence(ids, amount);
}

// ─── Format for prompt ────────────────────────────────────────────────────────

const TYPE_LABELS: Record<MemoryEntryType, string> = {
  learned_path:  "Learned paths (navigation sequences that worked)",
  ignore_region: "Regions/elements to IGNORE (don't interact with these)",
  avoid_region:  "Regions/elements to AVOID (caused failures before)",
  bug_pattern:   "Known bug patterns (watch for / work around these)",
  tip:           "Tips and hints",
};

export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";

  const grouped = new Map<MemoryEntryType, MemoryEntry[]>();
  for (const e of entries) {
    const arr = grouped.get(e.type) ?? [];
    arr.push(e);
    grouped.set(e.type, arr);
  }

  const sections: string[] = [];
  const typeOrder: MemoryEntryType[] = ["learned_path", "tip", "ignore_region", "avoid_region", "bug_pattern"];
  for (const t of typeOrder) {
    const items = grouped.get(t);
    if (!items || items.length === 0) continue;
    const lines = items.map((e) => {
      const conf = e.confidence >= 80 ? " [high confidence]" : e.confidence <= 30 ? " [low confidence]" : "";
      const regionNote = e.region?.description ? ` (region: ${e.region.description})` : "";
      return `  - ${e.summary}: ${e.content}${regionNote}${conf}`;
    });
    sections.push(`${TYPE_LABELS[t]}:\n${lines.join("\n")}`);
  }

  return `AGENT MEMORY (from previous runs — use this to guide your actions):\n${sections.join("\n\n")}`;
}

// ─── Propose memories from run results ────────────────────────────────────────

export type ProposedMemory = MemoryEntryInsert;

export function proposeMemoriesFromRun(
  steps: Array<{
    action: string;
    target?: string;
    reasoning?: string;
    url?: string;
    status: string;
    bugType?: string;
    severity?: string;
  }>,
  intent: string,
): ProposedMemory[] {
  const proposals: ProposedMemory[] = [];

  const okSteps = steps.filter((s) => s.status === "ok" && s.action !== "bug" && s.action !== "done" && s.action !== "auth");
  if (okSteps.length >= 2) {
    const pathDesc = okSteps
      .map((s) => {
        if (s.action === "navigate") return `navigate to ${s.target ?? "page"}`;
        if (s.action === "click") return `click "${s.target ?? "element"}"`;
        if (s.action === "fill") return `fill "${s.target ?? "field"}"`;
        return `${s.action} ${s.target ?? ""}`.trim();
      })
      .join(" → ");
    proposals.push({
      type: "learned_path",
      summary: `Path for: ${intent.slice(0, 80)}`,
      content: pathDesc,
      confidence: 60,
    });
  }

  const bugs = steps.filter((s) => s.action === "bug");
  for (const bug of bugs) {
    proposals.push({
      type: "bug_pattern",
      summary: `${bug.bugType ?? "bug"} on ${bug.url ?? "page"}`,
      content: bug.reasoning ?? "Bug detected during run",
      confidence: 50,
    });
  }

  const failedTargets = new Map<string, number>();
  for (const s of steps) {
    if (s.status === "failed" && s.target) {
      failedTargets.set(s.target, (failedTargets.get(s.target) ?? 0) + 1);
    }
  }
  for (const [target, count] of failedTargets) {
    if (count >= 2) {
      proposals.push({
        type: "avoid_region",
        summary: `Avoid "${target}"`,
        content: `Clicking/interacting with "${target}" failed ${count} times during a run.`,
        confidence: 40,
      });
    }
  }

  return proposals;
}

// ─── Legacy compat ─────────────────────────────────────────────────────────────

export type AgentFact = {
  selector: string;
  purpose: string;
  action: "fill" | "click" | "navigate";
  hits: number;
};
