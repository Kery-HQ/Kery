import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
  {
    variants: {
      variant: {
        default:     "bg-primary/10 text-primary",
        secondary:   "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive/10 text-destructive",
        outline:     "border border-border text-foreground",
        success:     "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        warning:     "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        neutral:     "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const dotColors: Record<string, string> = {
  default: "bg-primary",
  success: "bg-emerald-500",
  destructive: "bg-red-500",
  warning: "bg-amber-500",
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
        <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", dotColors[variant ?? "default"] ?? "bg-current")} />
      )}
      {children}
    </div>
  );
}
