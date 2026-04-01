import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  Hand,
  Keyboard,
  Loader2,
  MousePointerClick,
  Move,
  Navigation,
  Route,
  Scroll,
  ShieldCheck,
  TestTube2,
} from "lucide-react";

export type AgentLikeStep = {
  index?: number;
  action: string;
  target?: string;
  value?: string;
  assertion?: string;
  status?: "ok" | "failed" | "skipped" | string;
  reasoning?: string;
  doneResult?: "completed" | "blocked";
  observation?: string;
  bugType?: string;
  severity?: string;
};

export type HumanizedActivity = {
  title: string;
  detail?: string;
  icon: LucideIcon;
};

export function humanizeRunStep(step: AgentLikeStep): HumanizedActivity {
  const target = step.target?.trim();
  const value = step.value?.trim();
  const action = step.action;
  switch (action) {
    case "click":
      return { title: `Clicking ${target || "element"}`, detail: step.reasoning, icon: MousePointerClick };
    case "fill":
      return { title: `Filling ${target || "field"}`, detail: value || step.reasoning, icon: Keyboard };
    case "selectOption":
      return { title: `Selecting ${value || "option"}`, detail: target, icon: TestTube2 };
    case "setDate":
      return { title: `Setting date ${value || ""}`.trim(), detail: target, icon: TestTube2 };
    case "pressKey":
      return { title: `Pressing ${value || "key"}`, detail: target, icon: Keyboard };
    case "navigate":
      return { title: `Opening ${target || "page"}`, detail: step.reasoning, icon: Navigation };
    case "back":
      return { title: "Going back", detail: step.reasoning, icon: ArrowLeft };
    case "scroll":
      return { title: "Scrolling page", detail: step.reasoning, icon: Scroll };
    case "hover":
      return { title: `Hovering ${target || "element"}`, detail: step.reasoning, icon: Hand };
    case "dragAndDrop":
      return { title: "Dragging element", detail: target || step.reasoning, icon: Move };
    case "assert":
      return { title: `Checking ${step.assertion || "assertion"}`, detail: step.reasoning, icon: CheckCircle2 };
    case "wait":
      return { title: `Waiting ${value || ""}`.trim(), detail: step.reasoning, icon: Loader2 };
    case "observe":
      return { title: "Observing page state", detail: step.observation || step.reasoning, icon: Eye };
    case "plan":
      return { title: "Updating plan", detail: step.reasoning, icon: Route };
    case "auth":
      return { title: "Signing in", detail: target || step.reasoning, icon: ShieldCheck };
    case "bug":
      return {
        title: `Reporting ${step.bugType || "issue"} (${step.severity || "medium"})`,
        detail: step.reasoning,
        icon: AlertCircle,
      };
    case "done":
      return {
        title: `Finishing run (${step.doneResult || "completed"})`,
        detail: step.reasoning,
        icon: CheckCircle2,
      };
    default:
      return { title: `Running ${action}`, detail: step.reasoning, icon: TestTube2 };
  }
}
