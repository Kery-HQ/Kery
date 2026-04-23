import { cn } from "@/lib/utils";

interface PageHeaderProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({ icon, title, description, children, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "liquid-glass-strong flex items-center justify-between gap-4 px-6 h-12 rounded-none flex-shrink-0 border-0 border-b glass-divider",
        className
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && <span className="text-primary/70 flex-shrink-0">{icon}</span>}
        <h1 className="font-display font-semibold text-[14px] tracking-tight text-foreground truncate">{title}</h1>
        {description && (
          <span className="text-[12px] text-muted-foreground/70 hidden sm:inline truncate">{description}</span>
        )}
      </div>
      {children && <div className="flex items-center gap-2 flex-shrink-0">{children}</div>}
    </div>
  );
}
