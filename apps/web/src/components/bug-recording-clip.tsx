import React from "react";
import { ArrowsOut, Play, X } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type Step = { index?: number; at?: number };

const PRE_ROLL_MS = 5_000;
const POST_ROLL_MS = 10_000;

export function deriveBugClipRange(
  steps: Step[],
  recordingStartedAt: number | null | undefined,
  stepIndex: number | null | undefined,
): { startSec: number; endSec: number } | null {
  if (stepIndex == null || !Array.isArray(steps) || steps.length === 0) return null;

  const stepAtIdx = steps.find((s) => s.index === stepIndex && typeof s.at === "number");
  const fallbackStep = steps[Math.min(stepIndex, steps.length - 1)];
  const step = stepAtIdx ?? (typeof fallbackStep?.at === "number" ? fallbackStep : null);
  if (!step || typeof step.at !== "number") return null;

  const timed = steps.filter((s): s is Step & { at: number } => typeof s.at === "number");
  if (timed.length === 0) return null;
  const origin = recordingStartedAt ?? timed[0].at;

  const stepRelMs = Math.max(0, step.at - origin);
  const startSec = Math.max(0, (stepRelMs - PRE_ROLL_MS) / 1000);
  const endSec = (stepRelMs + POST_ROLL_MS) / 1000;
  return { startSec, endSec };
}

export function BugRecordingClip({
  videoUrl,
  startSec,
  endSec,
  posterSrc,
  bugName,
}: {
  videoUrl: string;
  startSec: number;
  endSec: number;
  posterSrc?: string;
  bugName?: string;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);

  const play = React.useCallback(() => {
    const node = videoRef.current;
    if (!node) return;
    try { node.currentTime = startSec; } catch { /* not yet ready */ }
    void node.play().catch(() => {});
  }, [startSec]);

  return (
    <>
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-black"
      >
        <video
          ref={videoRef}
          src={videoUrl}
          poster={posterSrc}
          preload="metadata"
          playsInline
          muted
          className="h-full w-full object-contain"
          onLoadedMetadata={() => {
            setReady(true);
            const node = videoRef.current;
            if (node) {
              try { node.currentTime = startSec; } catch { /* noop */ }
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            if (e.currentTarget.currentTime >= endSec) e.currentTarget.pause();
          }}
          onEnded={() => setPlaying(false)}
        />
        {!playing && (
          <button
            type="button"
            onClick={play}
            disabled={!ready}
            className="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/40 disabled:cursor-not-allowed"
            aria-label="Play clip"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-foreground">
              <Play className="h-5 w-5" weight="fill" />
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            videoRef.current?.pause();
            setFullscreen(true);
          }}
          className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white/90 transition-colors hover:bg-black/75"
          aria-label="Expand recording"
        >
          <ArrowsOut className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          className="max-w-[min(96vw,1400px)] w-[96vw] p-0 overflow-hidden bg-black border-0"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogTitle className="sr-only">
            {bugName ? `Recording: ${bugName}` : "Recording"}
          </DialogTitle>
          <div className="relative">
            <video
              src={videoUrl}
              controls
              autoPlay
              playsInline
              className="h-[80vh] w-full bg-black object-contain"
              onLoadedMetadata={(e) => {
                try { e.currentTarget.currentTime = startSec; } catch { /* noop */ }
              }}
            />
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white/90 transition-colors hover:bg-black/75"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
