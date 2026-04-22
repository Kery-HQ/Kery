/**
 * Regression Heal Agent
 *
 * When a regression step fails, this agent runs a full observe → decide → act
 * loop (same model + vision as Navigator) focused on completing the failed step
 * and any immediately dependent steps (e.g. open dropdown → select option → close).
 *
 * It sees the remaining plan from the failure point as context so it can
 * naturally cover logically grouped steps in one pass.
 *
 * Returns { resumeFromStepIndex, llmCalls } — the regression engine jumps to
 * that index and continues. If it made no progress, Navigator handoff fires.
 */
import type { Page } from "playwright";
import { logger } from "./logger.js";
import { llmChat, calcCostUsd } from "./llmClient.js";
import { getConfig } from "./config.js";
import {
  extractA11yTree, formatA11yForLLM, hasSufficientA11y,
  injectElementMarkers, removeElementMarkers, resolveElement,
} from "./a11yTree.js";
import type { A11yElement } from "./a11yTree.js";
import { waitForPageStable, executeAction, serializeWireMessagesForStorage, handleAuth } from "./agent.js";
import type { LLMCallRecord, RunStep } from "./agent.js";
import type { AuthConfig } from "./types.js";
import { drawGridOnScreenshot } from "./gridScan.js";
import type { RegressionStep } from "./regressionEngine.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 20;
/** Keep screenshots only in the most recent N user turns (mirrors Navigator). */
const IMAGE_KEEP_LAST = 2;
/** Collapse old user turns when conversation exceeds this length. */
const COLLAPSE_AFTER_TURNS = 8;
/** Keep the last N user/assistant pairs intact during collapse. */
const KEEP_FULL_TURNS = 3;

// ─── Output schema ─────────────────────────────────────────────────────────────

const HEAL_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "heal_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "fill", "navigate", "selectOption", "pressKey", "scroll", "hover", "back", "dragAndDrop", "setDate", "wait", "done", "give_up", "login", "gridScan"],
        },
        element:        { anyOf: [{ type: "integer" }, { type: "null" }] },
        target:         { anyOf: [{ type: "string" }, { type: "null" }] },
        value:          { anyOf: [{ type: "string" }, { type: "null" }] },
        x:              { anyOf: [{ type: "integer" }, { type: "null" }] },
        y:              { anyOf: [{ type: "integer" }, { type: "null" }] },
        resumeFromStep: { anyOf: [{ type: "integer" }, { type: "null" }] },
        reasoning:      { type: "string" },
      },
      required: ["action", "element", "target", "value", "x", "y", "resumeFromStep", "reasoning"],
      additionalProperties: false,
    },
  },
};

// ─── Prompt ────────────────────────────────────────────────────────────────────

function serializeRemainingSteps(plan: RegressionStep[], failedIndex: number): string {
  return plan.slice(failedIndex).map((s, i) => {
    const parts: string[] = [`[${failedIndex + i + 1}]`, s.action];
    if (s.role && s.name) parts.push(`${s.role}:"${s.name}"`);
    else if (s.name) parts.push(`"${s.name}"`);
    if (s.value) parts.push(`= "${s.value}"`);
    if (s.purpose) parts.push(`// ${s.purpose}`);
    return parts.join(" ");
  }).join("\n");
}

function serializeCompletedSteps(completedSteps: RunStep[]): string {
  if (completedSteps.length === 0) return "";
  const last10 = completedSteps.slice(-10);
  const lines = last10.map(s => {
    const target = s.elementRef ? `${s.elementRef.role}:"${s.elementRef.name}"` : (s.target ?? "");
    const val = s.value ? ` = "${s.value}"` : "";
    return `  ✓ [${s.index}] ${s.action} ${target}${val}`;
  });
  return `\nCompleted steps (last ${last10.length}):\n${lines.join("\n")}\n`;
}

function buildSystemPrompt(plan: RegressionStep[], failedIndex: number, completedSteps: RunStep[]): string {
  const remainingSteps = serializeRemainingSteps(plan, failedIndex);
  const completedSection = serializeCompletedSteps(completedSteps);
  return `You are recovering a failed regression test step. Your job is to make progress on the remaining plan steps using the current page state.
${completedSection}
Remaining plan steps (starting from the failed one):
${remainingSteps}

Each turn you will receive the current page URL, interactive elements, and a screenshot. Decide the next single action to take.

When you have completed one or more of the remaining steps and the page state confirms it, respond with action="done" and set resumeFromStep to the 1-based step number to resume from (matching the numbers in the plan above).

If the page is broken or you cannot make progress after trying alternatives, respond with action="give_up".

If you see a confirmation dialog or alert, accept it using the appropriate action.

For actions: use element index from the list, or target (text label), or x/y coordinates (0–1000 scale).
Available actions: click, fill, navigate, selectOption, pressKey, scroll, hover, back, dragAndDrop, setDate, wait.
- login: re-authenticate using the configured credentials if the page shows a login screen.
- gridScan: overlay a 0-1000 coordinate grid on the page screenshot so you can read precise x/y values before using dragAndDrop or other coordinate actions.`;
}

function buildObservation(url: string, dom: string, actionResult?: string, consecutiveErrors?: number): string {
  const resultSection = actionResult ? `\nLast action result: ${actionResult}` : "";
  const errorWarning = consecutiveErrors && consecutiveErrors >= 3
    ? `\nWARNING: ${consecutiveErrors} consecutive action failures. If you cannot make progress, respond with give_up.`
    : "";
  return `Current page: ${url}${resultSection}${errorWarning}

Interactive elements:
${dom}`;
}

// ─── Conversation pruning (mirrors Navigator) ──────────────────────────────────

function pruneConversation(messages: any[]): void {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    userCount++;
    if (!Array.isArray(msg.content)) continue;

    // Drop screenshots from older turns to keep context window small
    if (userCount > IMAGE_KEEP_LAST) {
      msg.content = msg.content.filter((p: any) => p.type !== "image_url");
    }

    // Collapse older turns to just "URL: ..." summary
    if (userCount > 1) {
      const textPart = msg.content.find((p: any) => p.type === "text");
      if (textPart?.text && textPart.text.length > 200) {
        const urlMatch = textPart.text.match(/^Current page: (.+?)$/m);
        const resultMatch = textPart.text.match(/^Last action result: (.+?)$/m);
        textPart.text = [
          resultMatch ? resultMatch[1] : null,
          urlMatch ? `URL: ${urlMatch[1]}` : null,
        ].filter(Boolean).join(" | ") || textPart.text.slice(0, 100);
      }
    }
  }

  // Aggressive collapse: merge old turns into a single summary block
  if (userCount > COLLAPSE_AFTER_TURNS) {
    collapseOldTurns(messages);
  }
}

function collapseOldTurns(messages: any[]): void {
  // messages[0] is system. Keep system + last KEEP_FULL_TURNS*2 messages intact.
  const keepTail = KEEP_FULL_TURNS * 2 + 1;
  if (messages.length <= keepTail + 4) return;

  const cutoff = messages.length - keepTail;
  const collapsedLines: string[] = [];
  for (let i = 1; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(typeof msg.content === "string" ? msg.content : "");
        if (parsed?.action) {
          const val = parsed.value ? ` "${parsed.value}"` : "";
          collapsedLines.push(`${parsed.action} ${parsed.target ?? ""}${val}`.trim());
        }
      } catch { /* skip */ }
    } else if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join(" ")
          : "";
      const urlMatch = text.match(/URL: (.+?)(\n|$)/);
      const resultMatch = text.match(/Last action result: (.+?)(\n|$)/);
      if (resultMatch || urlMatch) {
        collapsedLines.push([resultMatch?.[1], urlMatch ? `@ ${urlMatch[1]}` : null].filter(Boolean).join(" "));
      }
    }
  }

  if (collapsedLines.length === 0) return;

  const summaryMsg = {
    role: "user" as const,
    content: [{ type: "text", text: `EARLIER ACTIONS (condensed):\n${collapsedLines.join("\n")}` }],
  };
  messages.splice(1, cutoff - 1, summaryMsg);
}

// ─── Snapshot helper ───────────────────────────────────────────────────────────

async function takeSnapshot(page: Page): Promise<{ dom: string; elements: A11yElement[]; markedScreenshot: Buffer; sufficient: boolean }> {
  // Try up to twice — the first attempt may catch the page mid-navigation/load.
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForPageStable(page, attempt === 0 ? 1500 : 4000);
    const { elements, textNodes } = await extractA11yTree(page);
    if (!hasSufficientA11y(elements)) continue;
    await injectElementMarkers(page, elements);
    const markedScreenshot = await page.screenshot({ type: "jpeg", quality: 75 }).catch(() => Buffer.alloc(0));
    await removeElementMarkers(page);
    const dom = formatA11yForLLM(elements, textNodes);
    return { dom, elements, markedScreenshot, sufficient: true };
  }
  return { dom: "", elements: [], markedScreenshot: Buffer.alloc(0), sufficient: false };
}

// ─── Main export ───────────────────────────────────────────────────────────────

export type HealResult = {
  /** Plan array index to resume from. Equals failedIndex if no progress was made. */
  resumeFromStepIndex: number;
  llmCalls: LLMCallRecord[];
};

export async function healWithMicroAgent(
  page: Page,
  plan: RegressionStep[],
  failedIndex: number,
  completedSteps: RunStep[],
  onScreenshot?: (screenshot: Buffer, cleanScreenshot: Buffer, domHash: string) => void,
  onHealCall?: (call: LLMCallRecord) => void,
  auth?: AuthConfig | null,
): Promise<HealResult> {
  const config = getConfig();
  const model = config.agentModel;
  const llmCalls: LLMCallRecord[] = [];
  let authAttempts = 0;
  const MAX_AUTH_ATTEMPTS = 2;

  logger.info(
    { failedIndex, action: plan[failedIndex]?.action, name: plan[failedIndex]?.name },
    "Heal agent: starting recovery loop",
  );

  // Install dialog auto-accept handler (mirrors Navigator) so confirm/alert boxes don't block actions
  const onDialog = (dialog: any) => {
    logger.info({ type: dialog.type(), message: dialog.message() }, "Heal agent: auto-accepting dialog");
    dialog.accept().catch(() => {});
  };
  page.on("dialog", onDialog);

  // Multi-turn conversation — system prompt is static, user/assistant turns accumulate.
  const messages: any[] = [
    { role: "system", content: buildSystemPrompt(plan, failedIndex, completedSteps) },
  ];

  let lastActionResult: string | undefined;
  let consecutiveErrors = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const url = page.url();
      const { dom, elements: currentElements, markedScreenshot, sufficient } = await takeSnapshot(page);

      if (!sufficient) {
        logger.warn({ turn, url }, "Heal agent: insufficient a11y — giving up");
        break;
      }

      // Forward the marked screenshot as a live frame so it appears in the UI
      if (markedScreenshot.length > 0) {
        onScreenshot?.(markedScreenshot, markedScreenshot, `heal:${failedIndex}:${turn}:${Date.now()}`);
      }

      // Push this turn's observation as a user message (url + dom + screenshot)
      const observationText = buildObservation(url, dom, lastActionResult, consecutiveErrors);
      const userMessage = {
        role: "user",
        content: [
          { type: "text", text: observationText },
          ...(markedScreenshot.length > 0
            ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${markedScreenshot.toString("base64")}` } }]
            : []),
        ],
      };
      messages.push(userMessage);
      lastActionResult = undefined;

      // Prune conversation to keep token count manageable (mirrors Navigator)
      pruneConversation(messages);

      const t0 = Date.now();
      let content: string;
      let usage: any;

      try {
        ({ content, usage } = await llmChat(messages, model, {
          maxTokens: 512,
          temperature: 0.1,
          responseFormat: HEAL_SCHEMA,
        }));
      } catch (err) {
        logger.warn({ turn, err: String(err).slice(0, 200) }, "Heal agent: LLM call failed");
        break;
      }

      const durationMs = Date.now() - t0;

      // Serialize messages exactly like Navigator so screenshots appear in LLM steps UI
      const { messages: requestMessages, imageBase64s } = serializeWireMessagesForStorage(messages);

      const callRecord: LLMCallRecord = {
        seq: 0,
        stepIndex: failedIndex,
        model,
        hasVision: markedScreenshot.length > 0,
        attempt: turn + 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        durationMs,
        costUsd: calcCostUsd(model, usage.inputTokens, usage.outputTokens, "agentModel"),
        query: observationText.slice(0, 4000),
        requestMessages,
        imageBase64s: imageBase64s.length > 0 ? imageBase64s : undefined,
        imageBase64: imageBase64s[0],
        response: content ?? "",
        agent: "regression_heal" as any,
      };
      llmCalls.push(callRecord);
      // Stream each heal call immediately (fixes issue #6)
      onHealCall?.(callRecord);

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        logger.warn({ turn, content: content?.slice(0, 200) }, "Heal agent: unparsable response");
        break;
      }

      // Push assistant reply into the conversation so the next turn sees it
      messages.push({ role: "assistant", content });

      logger.info(
        { turn, action: parsed.action, target: parsed.target, element: parsed.element, resumeFromStep: parsed.resumeFromStep, reasoning: parsed.reasoning },
        "Heal agent: decision",
      );

      if (parsed.action === "give_up") {
        logger.info({ turn }, "Heal agent: gave up");
        break;
      }

      if (parsed.action === "done") {
        // resumeFromStep is 1-based matching the plan numbers shown in the prompt
        const resume = typeof parsed.resumeFromStep === "number"
          ? Math.min(Math.max(parsed.resumeFromStep - 1, failedIndex + 1), plan.length)
          : failedIndex + 1;
        logger.info({ turn, resumeFromStepIndex: resume }, "Heal agent: done, resuming regression");
        return { resumeFromStepIndex: resume, llmCalls };
      }

      if (parsed.action === "login") {
        logger.info({ turn, authAttempts }, "Heal agent: login meta-action");
        if (authAttempts >= MAX_AUTH_ATTEMPTS) {
          lastActionResult = "Re-login cap reached; continuing with current session.";
        } else if (!auth) {
          lastActionResult = "No auth configuration available for this run.";
        } else {
          authAttempts++;
          const reAuthResult = await handleAuth(page, auth);
          lastActionResult = reAuthResult.ok ? "Re-login succeeded." : "Re-login failed.";
          logger.info({ ok: reAuthResult.ok, authAttempts }, "Heal agent: re-auth result");
        }
        continue;
      }

      if (parsed.action === "gridScan") {
        logger.info({ turn }, "Heal agent: gridScan meta-action");
        const raw = await page.screenshot({ type: "jpeg", quality: 85 }).catch(() => Buffer.alloc(0));
        if (raw.length > 0) {
          const gridded = await drawGridOnScreenshot(raw).catch(() => raw);
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Coordinate grid overlay (0-1000 scale). Read x/y values directly from the grid labels, then use them in your next action." },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${gridded.toString("base64")}` } },
            ],
          });
        } else {
          lastActionResult = "gridScan: could not capture screenshot.";
        }
        continue;
      }

      // Execute — mirror the Navigator: resolve element index → locator first,
      // then fall back to executeAction for x/y or target-based actions.
      const resolvedA11yEl = parsed.element != null
        ? currentElements.find(e => e.id === parsed.element)
        : undefined;
      try {
        if (resolvedA11yEl) {
          const locator = await resolveElement(page, resolvedA11yEl);
          if (locator) {
            if (parsed.action === "click") {
              await locator.click({ timeout: 5000 });
              await waitForPageStable(page, 4000);
            } else if (parsed.action === "fill" && parsed.value != null) {
              await locator.fill(parsed.value, { timeout: 5000 });
            } else if (parsed.action === "selectOption" && parsed.value) {
              await locator.selectOption({ label: parsed.value }, { timeout: 5000 }).catch(async () => {
                await locator.click({ timeout: 3000 });
                await page.getByText(parsed.value, { exact: false }).first().click({ timeout: 3000 });
              });
            } else {
              await executeAction(page, {
                action: parsed.action,
                target: resolvedA11yEl.name ?? parsed.target ?? undefined,
                value: parsed.value ?? undefined,
                x: parsed.x ?? undefined,
                y: parsed.y ?? undefined,
                reasoning: parsed.reasoning,
              });
            }
          } else {
            throw new Error(`Could not resolve locator for element ${parsed.element}`);
          }
        } else {
          await executeAction(page, {
            action: parsed.action,
            target: parsed.target ?? undefined,
            value: parsed.value ?? undefined,
            x: parsed.x ?? undefined,
            y: parsed.y ?? undefined,
            reasoning: parsed.reasoning,
          });
        }
        const label = resolvedA11yEl?.name ?? parsed.target ?? parsed.element ?? "";
        lastActionResult = `${parsed.action} "${label}" succeeded`;
        consecutiveErrors = 0;
      } catch (err) {
        logger.warn({ turn, action: parsed.action, err: String(err).slice(0, 150) }, "Heal agent: action failed");
        lastActionResult = `${parsed.action} FAILED — ${String(err).slice(0, 100)}`;
        consecutiveErrors++;
        // Give up after 5 consecutive failures — avoid burning turns on broken state
        if (consecutiveErrors >= 5) {
          logger.warn({ turn, consecutiveErrors }, "Heal agent: 5 consecutive failures — giving up");
          break;
        }
      }
    }
  } finally {
    page.off("dialog", onDialog);
  }

  return { resumeFromStepIndex: failedIndex, llmCalls };
}
