import { cn } from "@/lib/utils";

interface KpiCardProps {
  label: string;
  value: string | number;
  suffix?: string;
  icon?: React.ReactNode;
  className?: string;
}

export function KpiCard({ label, value, suffix, icon, className }: KpiCardProps) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        {suffix && <span className="text-[12px] text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}
