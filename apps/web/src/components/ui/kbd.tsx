import { cn } from "@/lib/utils";

export function Kbd({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 items-center justify-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground font-mono",
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
