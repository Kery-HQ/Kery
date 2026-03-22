import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
  {
    variants: {
      variant: {
        default:     "bg-primary/10 text-primary",
        secondary:   "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive/10 text-destructive",
        outline:     "border border-border text-foreground",
        success:     "bg-status-pass/10 text-status-pass",
        warning:     "bg-status-warn/10 text-status-warn",
        neutral:     "bg-muted text-muted-foreground",
        running:     "bg-status-running/10 text-status-running",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const dotColors: Record<string, string> = {
  default: "bg-primary",
  success: "bg-status-pass",
  destructive: "bg-status-fail",
  warning: "bg-status-warn",
  running: "bg-status-running",
  neutral: "bg-muted-foreground/40",
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
