import { cn } from "@/lib/utils";

interface PageHeaderProps {
  icon?: React.ReactNode;
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({ icon, eyebrow, title, description, children, className }: PageHeaderProps) {
  return (
    <div className={cn("flex-shrink-0 px-6 pt-6", className)}>
      <div className="mb-5 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-primary">
              {eyebrow}
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2">
            {icon && <span className="flex-shrink-0 text-primary">{icon}</span>}
            <h1 className="truncate text-[22px] font-semibold leading-7 tracking-tight text-foreground">{title}</h1>
          </div>
          {description && (
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
