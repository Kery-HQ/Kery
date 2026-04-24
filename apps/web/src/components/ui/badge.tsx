import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
  {
    variants: {
      variant: {
        default:
          "bg-foreground/10 text-foreground dark:bg-white/12 dark:text-white/90",
        secondary:
          "bg-muted text-muted-foreground",
        destructive:
          "bg-destructive/14 text-destructive dark:bg-destructive/20 dark:text-red-300",
        outline:
          "border border-border/80 text-foreground bg-transparent",
        success:
          "bg-status-pass/14 text-status-pass dark:bg-status-pass/18 dark:text-emerald-300",
        warning:
          "bg-status-warn/14 text-status-warn dark:bg-status-warn/18 dark:text-amber-300",
        neutral:
          "bg-black/8 text-foreground/70 dark:bg-white/10 dark:text-white/60",
        running:
          "bg-status-running/14 text-status-running dark:bg-status-running/20 dark:text-blue-300",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const dotColors: Record<string, string> = {
  default:     "bg-foreground dark:bg-white",
  success:     "bg-status-pass",
  destructive: "bg-status-fail",
  warning:     "bg-status-warn",
  running:     "bg-status-running",
  neutral:     "bg-muted-foreground/50",
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full flex-shrink-0",
            variant === "running" && "dot-pulse",
            dotColors[variant ?? "default"] ?? "bg-current",
          )}
        />
      )}
      {children}
    </div>
  );
}
