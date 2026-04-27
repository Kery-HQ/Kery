import React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useNavigate, useLocation } from "react-router-dom";
import { Path, ListChecks, Bug } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projectContext";
import { createProject } from "@/projectApi";

const WELCOMED_KEY = "kery_welcomed";

const FEATURES = [
  {
    icon: Path,
    title: "Map every route",
    description: "Kery crawls your app like a real user and builds a full map of your routes and flows.",
  },
  {
    icon: ListChecks,
    title: "Write tests in plain language",
    description: "No selectors, no scripts. Describe what to check and the agent figures out the rest.",
  },
  {
    icon: Bug,
    title: "Surface bugs automatically",
    description: "Visual regressions, broken flows, UX issues — caught, triaged, and ready to review.",
  },
];

function normalizeDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

export function WelcomeModal() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, projectsLoaded, refreshProjects, setCurrentProjectId } = useProject();

  const preview = new URLSearchParams(location.search).get("welcome") === "1";

  const [dismissed, setDismissed] = React.useState(
    () => localStorage.getItem(WELCOMED_KEY) === "true"
  );
  const [step, setStep] = React.useState(0);
  const [projectName, setProjectName] = React.useState("");
  const [projectDomain, setProjectDomain] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const open = preview || (projectsLoaded && projects.length === 0 && !dismissed);

  React.useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  function handleDismiss() {
    if (preview) {
      const params = new URLSearchParams(location.search);
      params.delete("welcome");
      const qs = params.toString();
      navigate(location.pathname + (qs ? `?${qs}` : ""), { replace: true });
      return;
    }
    localStorage.setItem(WELCOMED_KEY, "true");
    setDismissed(true);
  }

  async function handleCreate() {
    if (!projectName.trim()) return;
    setCreating(true);
    try {
      const domain = normalizeDomain(projectDomain);
      const res = await createProject(projectName.trim(), domain || undefined);
      await refreshProjects();
      if (res.project?.id) {
        setCurrentProjectId(res.project.id);
        navigate("/overview");
      }
    } finally {
      setCreating(false);
    }
  }

  const TOTAL = 3;
  const isLast = step === TOTAL - 1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) handleDismiss(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Content className="w-full max-w-[500px] rounded-xl animate-scale-in focus-visible:outline-none bg-popover border border-border shadow-[var(--shadow-lg)]">
            <DialogPrimitive.Title className="sr-only">Welcome to Kery</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Set up your first project to get started.</DialogPrimitive.Description>

            {/* Slide area */}
            <div className="min-h-[280px] flex flex-col">
              <div key={step} className="animate-fade-in flex flex-col flex-1">
                {step === 0 && <WelcomeSlide />}
                {step === 1 && <FeaturesSlide />}
                {step === 2 && (
                  <CreateSlide
                    name={projectName}
                    domain={projectDomain}
                    onNameChange={setProjectName}
                    onDomainChange={setProjectDomain}
                    onCreate={handleCreate}
                  />
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 pb-6 pt-3 border-t border-border">
              <div className="flex items-center gap-1.5">
                {Array.from({ length: TOTAL }).map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "h-1 rounded-full transition-all duration-200",
                      i === step ? "w-5 bg-primary" : "w-1.5 bg-border"
                    )}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[12px] text-muted-foreground"
                  onClick={isLast ? handleDismiss : () => setStep(TOTAL - 1)}
                >
                  {isLast ? "Skip for now" : "Skip"}
                </Button>
                {!isLast && (
                  <Button
                    size="sm"
                    onClick={() => setStep(step + 1)}
                  >
                    Next
                  </Button>
                )}
                {isLast && (
                  <Button
                    size="sm"
                    onClick={handleCreate}
                    disabled={!projectName.trim() || creating}
                    loading={creating}
                  >
                    Create project
                  </Button>
                )}
              </div>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function WelcomeSlide() {
  return (
    <div className="flex flex-col flex-1">
      {/* Hero area */}
      <div className="flex flex-col items-center justify-center gap-5 px-6 pt-10 pb-8 text-center">
        <img
          src="/logo/kery.png"
          alt="Kery"
          className="h-16 w-16 rounded-2xl"
          style={{ imageRendering: "pixelated" }}
        />
        <div className="space-y-3">
          <h2 className="text-[22px] font-semibold tracking-tight text-foreground">
            Welcome to Kery
          </h2>
          <p className="text-[13px] text-muted-foreground leading-relaxed max-w-[340px]">
            The AI testing agent for your web app. Point it at a URL — it
            maps your routes, runs tests in a real browser, and surfaces bugs
            before your users do.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 border-t border-border">
        {[
          { value: "Zero", label: "test scripts" },
          { value: "Real", label: "browser engine" },
          { value: "Auto", label: "bug triage" },
        ].map((stat, i) => (
          <div
            key={stat.label}
            className={cn(
              "flex flex-col items-center gap-0.5 py-4",
              i < 2 && "border-r border-border"
            )}
          >
            <span className="text-[15px] font-semibold text-primary tabular-nums">
              {stat.value}
            </span>
            <span className="text-[11px] text-muted-foreground">{stat.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeaturesSlide() {
  return (
    <div className="flex flex-col gap-3 flex-1 px-6 pt-6 pb-4">
      <div className="space-y-0.5">
        <p className="text-[14px] font-semibold text-foreground">What Kery does</p>
        <p className="text-[12px] text-muted-foreground">Three steps from zero to coverage.</p>
      </div>
      <div className="space-y-2 pt-1">
        {FEATURES.map((f, i) => (
          <div key={f.title} className="flex items-start gap-3.5 p-3.5 rounded-lg bg-card border border-border">
            <div className="flex items-center justify-center h-8 w-8 rounded-md bg-primary/10 shrink-0 mt-0.5">
              <f.icon className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-foreground">{f.title}</p>
                <span className="text-[10px] font-mono text-muted-foreground/60">0{i + 1}</span>
              </div>
              <p className="text-[12px] text-muted-foreground leading-snug mt-0.5">
                {f.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateSlide({
  name,
  domain,
  onNameChange,
  onDomainChange,
  onCreate,
}: {
  name: string;
  domain: string;
  onNameChange: (v: string) => void;
  onDomainChange: (v: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-5 flex-1 px-6 pt-6 pb-4">
      <div className="space-y-1">
        <p className="text-[14px] font-semibold text-foreground">Create your first project</p>
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          A project holds your environments, test flows, runs, and bugs. You
          can rename it or add more projects any time.
        </p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[12px] font-medium text-foreground">Project name</label>
          <Input
            autoFocus
            placeholder="My App"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(); }}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[12px] font-medium text-foreground">
            Domain{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input
            placeholder="myapp.com"
            value={domain}
            onChange={(e) => onDomainChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(); }}
          />
          <p className="text-[11px] text-muted-foreground">
            Used as a default base URL when scanning your app.
          </p>
        </div>
      </div>
    </div>
  );
}
