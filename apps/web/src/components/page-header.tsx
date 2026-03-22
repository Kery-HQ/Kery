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
    <div className={cn("flex items-center justify-between gap-4 px-6 h-12 border-b border-border bg-card/50 flex-shrink-0", className)}>
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="text-muted-foreground flex-shrink-0">{icon}</span>}
        <h1 className="text-[13px] font-semibold text-foreground truncate">{title}</h1>
        {description && (
          <span className="text-[12px] text-muted-foreground hidden sm:inline truncate">{description}</span>
        )}
      </div>
      {children && <div className="flex items-center gap-2 flex-shrink-0">{children}</div>}
    </div>
  );
}
