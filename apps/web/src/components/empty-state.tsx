import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 text-center", className)}>
      {icon && <div className="mb-3 text-muted-foreground/40">{icon}</div>}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description && <p className="text-[12px] text-muted-foreground mt-1 max-w-xs">{description}</p>}
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick} className="mt-4">
          {action.label}
        </Button>
      )}
    </div>
  );
}
