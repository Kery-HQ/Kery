import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "bg-card border-border text-foreground text-[13px] rounded-lg shadow-lg",
          description: "text-muted-foreground text-[12px]",
          actionButton: "bg-primary text-primary-foreground text-[12px]",
        },
      }}
    />
  );
}
