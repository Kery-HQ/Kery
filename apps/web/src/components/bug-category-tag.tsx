import { cn } from "@/lib/utils";
import { bugCategoryTagClass } from "@/lib/bug-issue-display";

export function BugCategoryTag({ category }: { category: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize flex-shrink-0",
        bugCategoryTagClass(category),
      )}
    >
      {category}
    </span>
  );
}
