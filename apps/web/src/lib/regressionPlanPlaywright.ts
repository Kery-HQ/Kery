/**
 * Approximate Playwright/TypeScript for display — mirrors packages/engine regressionEngine
 * executeRegressionStep patterns. Runtime may use Stagehand healing not shown here.
 */

export type PlanStepForSnippet = {
  action: string;
  role?: string;
  name?: string;
  value?: string;
  url?: string;
  purpose?: string;
  doneWhen?: { type: string; value?: string; role?: string; name?: string; text?: string };
};

function jsStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

function locatorExpr(step: PlanStepForSnippet): string | null {
  if (step.role && step.name) {
    return `page.getByRole(${jsStr(step.role)}, { name: ${jsStr(step.name)}, exact: false })`;
  }
  if (step.role) {
    return `page.getByRole(${jsStr(step.role)})`;
  }
  if (step.name) {
    return `page.getByText(${jsStr(step.name)}, { exact: false })`;
  }
  return null;
}

export function regressionPlanToPlaywrightSnippet(steps: PlanStepForSnippet[]): string {
  const lines: string[] = [
    "// Preview generated from your saved replay plan.",
    "// Kery runs this logic internally; healing/fallbacks are omitted here.",
    "",
    "async function replay(page) {",
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = step.purpose?.trim() || `${step.action}`;
    lines.push(`  // ${i + 1}. ${label.replace(/\n/g, " ")}`);

    if (step.url && step.action !== "navigate") {
      lines.push(`  // expect page: ${step.url}`);
    }

    switch (step.action) {
      case "navigate":
        if (step.value) {
          lines.push(`  await page.goto(${jsStr(step.value)}, { waitUntil: "domcontentloaded" });`);
        }
        break;
      case "back":
        lines.push(`  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});`);
        break;
      case "wait": {
        const ms = Math.min(Number(step.value) || 1000, 5000);
        lines.push(`  await page.waitForTimeout(${ms});`);
        break;
      }
      case "pressKey":
        if (step.value) {
          lines.push(`  await page.keyboard.press(${jsStr(step.value)});`);
        }
        break;
      case "scroll": {
        const raw = (step.value ?? "down 300").trim().toLowerCase();
        const m = raw.match(/^(up|down|left|right)\s+(\d+)$/);
        if (m) {
          const dir = m[1];
          const amount = Math.min(Number(m[2]), 2000);
          const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
          const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
          lines.push(`  await page.mouse.wheel(${dx}, ${dy});`);
        }
        break;
      }
      case "assert":
        if (step.value) {
          lines.push(
            `  await page.getByText(${jsStr(step.value)}, { exact: false }).waitFor({ state: "visible", timeout: 5000 });`,
          );
        }
        break;
      case "selectOption":
        if (step.role === "combobox" && step.value) {
          const namePart = step.name
            ? `.getByRole("combobox", { name: ${jsStr(step.name)}, exact: false }).first()`
            : `.getByRole("combobox").first()`;
          lines.push(
            `  await page${namePart}.selectOption({ label: ${jsStr(step.value)} }, { timeout: 5000 });`,
          );
        } else {
          const loc = locatorExpr(step);
          if (loc && step.value) {
            lines.push(`  await ${loc}.first().selectOption({ label: ${jsStr(step.value)} }, { timeout: 8000 });`);
          }
        }
        break;
      case "click": {
        const loc = locatorExpr(step);
        if (loc) lines.push(`  await ${loc}.first().click({ timeout: 12000 });`);
        break;
      }
      case "fill": {
        const loc = locatorExpr(step);
        if (loc && step.value !== undefined) {
          lines.push(`  await ${loc}.first().fill(${jsStr(String(step.value))}, { timeout: 8000 });`);
        }
        break;
      }
      default:
        lines.push(`  // (unsupported in preview: ${step.action})`);
    }

    if (step.doneWhen) {
      const dw = step.doneWhen;
      let hint = dw.type;
      if (dw.value) hint += ` ${dw.value}`;
      if (dw.text) hint += ` "${dw.text}"`;
      if (dw.name) hint += ` ${dw.role}:"${dw.name}"`;
      lines.push(`  // done when: ${hint}`);
    }
    lines.push("");
  }

  lines.push("}");
  return lines.join("\n").replace(/\n\n+$/, "\n");
}
