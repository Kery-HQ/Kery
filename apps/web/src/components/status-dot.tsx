import { cn } from "@/lib/utils";

const colorMap: Record<string, string> = {
  passed: "bg-status-pass",
  pass: "bg-status-pass",
  success: "bg-status-pass",
  clean: "bg-status-pass",
  failed: "bg-status-fail",
  fail: "bg-status-fail",
  error: "bg-status-fail",
  issues: "bg-status-fail",
  running: "bg-status-running",
  queued: "bg-status-running",
  warning: "bg-status-warn",
  stale: "bg-status-warn",
  partial: "bg-status-warn",
};

interface StatusDotProps {
  status: string;
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ status, pulse, className }: StatusDotProps) {
  const shouldPulse = pulse ?? (status === "running" || status === "queued");
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full flex-shrink-0",
        colorMap[status] ?? "bg-muted-foreground/40",
        shouldPulse && "dot-pulse",
        className
      )}
    />
  );
}
