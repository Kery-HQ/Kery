import type { Icon } from "@phosphor-icons/react";
import {
  WarningCircle,
  ArrowLeft,
  CheckCircle,
  Eye,
  Hand,
  Keyboard,
  Spinner,
  CursorClick,
  ArrowsOutCardinal,
  NavigationArrow,
  Path,
  Scroll,
  ShieldCheck,
  TestTube,
} from "@phosphor-icons/react";

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
  icon: Icon;
};

export function humanizeRunStep(step: AgentLikeStep): HumanizedActivity {
  const target = step.target?.trim();
  const value = step.value?.trim();
  const action = step.action;
  switch (action) {
    case "click":
      return { title: `Clicking ${target || "element"}`, detail: step.reasoning, icon: CursorClick };
    case "fill":
      return { title: `Filling ${target || "field"}`, detail: value || step.reasoning, icon: Keyboard };
    case "selectOption":
      return { title: `Selecting ${value || "option"}`, detail: target, icon: TestTube };
    case "setDate":
      return { title: `Setting date ${value || ""}`.trim(), detail: target, icon: TestTube };
    case "pressKey":
      return { title: `Pressing ${value || "key"}`, detail: target, icon: Keyboard };
    case "navigate":
      return { title: `Opening ${target || "page"}`, detail: step.reasoning, icon: NavigationArrow };
    case "back":
      return { title: "Going back", detail: step.reasoning, icon: ArrowLeft };
    case "scroll":
      return { title: "Scrolling page", detail: step.reasoning, icon: Scroll };
    case "hover":
      return { title: `Hovering ${target || "element"}`, detail: step.reasoning, icon: Hand };
    case "dragAndDrop":
      return { title: "Dragging element", detail: target || step.reasoning, icon: ArrowsOutCardinal };
    case "assert":
      return { title: `Checking ${step.assertion || "assertion"}`, detail: step.reasoning, icon: CheckCircle };
    case "wait":
      return { title: `Waiting ${value || ""}`.trim(), detail: step.reasoning, icon: Spinner };
    case "observe":
      return { title: "Observing page state", detail: step.observation || step.reasoning, icon: Eye };
    case "plan":
      return { title: "Updating plan", detail: step.reasoning, icon: Path };
    case "auth":
      return { title: "Signing in", detail: target || step.reasoning, icon: ShieldCheck };
    case "bug":
      return {
        title: `Reporting ${step.bugType || "issue"} (${step.severity || "medium"})`,
        detail: step.reasoning,
        icon: WarningCircle,
      };
    case "done":
      return { title: "Run finished", detail: step.reasoning, icon: CheckCircle };
    default:
      return { title: action || "Step", detail: step.reasoning, icon: Path };
  }
}
