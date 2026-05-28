/** Maps bug severity to StatusDot `status` prop (Issues + Run detail). */
export const BUG_SEVERITY_STATUS_DOT: Record<string, string> = {
  high: "error",
  medium: "warning",
  low: "low",
};

/**
 * User-facing bug status labels.
 * The DB stores 4 states (open/in_progress/resolved/wont_fix) which we
 * surface as triage states: Needs review, To fix, Fixed, Ignored.
 */
export const BUG_STATUS_LABEL: Record<string, string> = {
  open: "Needs review",
  in_progress: "To fix",
  resolved: "Fixed",
  wont_fix: "Ignored",
};

export function bugStatusLabel(status: string | null | undefined): string {
  if (!status) return BUG_STATUS_LABEL.open;
  return BUG_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

export const BUG_STATUS_BADGE: Record<string, "success" | "warning" | "neutral" | "destructive"> = {
  open: "warning",
  in_progress: "warning",
  resolved: "success",
  wont_fix: "neutral",
};

/**
 * Category label colors — text only (no border); Issues + Run detail.
 * Overview bug rows stay plain outline per Overview.tsx.
 */
export function bugCategoryTagClass(category: string): string {
  switch (category) {
    case "visual":
      return "text-violet-700 dark:text-violet-300";
    case "functional":
      return "text-primary";
    case "ux":
      return "text-amber-800 dark:text-amber-200";
    case "other":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

/** Short title for run JSON bug rows (`bugs_json`). */
export function runJsonBugDisplayName(bug: {
  name?: string;
  reasoning?: string;
  category?: string;
  bugType?: string;
}): string {
  const n = (bug.name ?? "").trim();
  if (n) return n;
  const reason = (bug.reasoning ?? "").trim();
  if (reason) {
    const line = reason.split("\n")[0]?.trim() ?? "";
    if (line.length > 120) return `${line.slice(0, 117)}…`;
    return line || "Issue";
  }
  const cat = (bug.category ?? bug.bugType ?? "issue") as string;
  return `Issue (${cat})`;
}

/**
 * Longer detail text — not the same string as the title when avoidable.
 * Prefers `description` when it adds detail; otherwise uses full `reasoning`.
 */
export function runJsonBugDetailDescription(
  bug: { name?: string; description?: string; reasoning?: string },
  displayName: string,
): string {
  const rawDesc = (bug.description ?? "").trim();
  const rawReason = (bug.reasoning ?? "").trim();
  if (rawDesc && rawDesc !== displayName) return rawDesc;
  if (rawReason && rawReason !== displayName) return rawReason;
  if (rawDesc && rawReason && rawDesc === displayName && rawReason.length > rawDesc.length) {
    const rest = rawReason.slice(rawDesc.length).trim();
    if (rest) return rest;
  }
  return "";
}

/** Project `bugs` row: longer detail when it is not identical to the title. */
export function projectBugDetailDescription(bug: { name: string; description: string }): string {
  const n = bug.name.trim();
  const d = bug.description.trim();
  if (!d || d === n) return "";
  return d;
}
