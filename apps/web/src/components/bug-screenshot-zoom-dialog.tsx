import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type BugScreenshotZoomDialogProps = {
  src: string;
  alt?: string;
  /** Thumbnail / trigger */
  triggerClassName?: string;
  thumbnailClassName?: string;
};

/**
 * Large lightbox for bug screenshots (scrollable if the image exceeds the viewport).
 */
export function BugScreenshotZoomDialog({
  src,
  alt = "Bug screenshot",
  triggerClassName,
  thumbnailClassName,
}: BugScreenshotZoomDialogProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "rounded-lg border border-border overflow-hidden hover:ring-1 hover:ring-primary/30 transition-all cursor-zoom-in",
          triggerClassName,
        )}
      >
        <img
          src={src}
          alt={alt}
          className={cn("max-w-full max-h-[200px] object-contain bg-black/5", thumbnailClassName)}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "flex max-h-[min(92vh,1000px)] h-[min(92vh,1000px)] w-[min(96vw,1440px)] max-w-[min(96vw,1440px)] flex-col gap-0 p-0 overflow-hidden",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader className="flex-shrink-0 border-b border-border px-4 py-3 pr-12 mb-0">
            <DialogTitle className="text-[14px] font-semibold">Screenshot</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
            <img
              src={src}
              alt={alt}
              className="w-full h-auto max-w-full rounded-lg border border-border bg-black/5 object-contain shadow-sm"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
