import { llmSummarize, calcCostUsd } from "./llmClient.js";
import { getConfig } from "./config.js";

export type SummarizeResult = {
  summary: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
  model?: string;
  durationMs?: number;
};

export async function summarizeRun(intent: string, status: string, steps: string[], videoUrl?: string): Promise<SummarizeResult> {
  const stepList = steps.length > 0
    ? steps.slice(-20).join("\n")
    : "No steps recorded.";

  const prompt = `Summarize this E2E browser test run in 3-5 bullet points.

Intent: ${intent}
Status: ${status}
Video: ${videoUrl || "n/a"}

Steps taken:
${stepList}

Focus on what the agent did, what succeeded, and what failed if applicable.`;

  try {
    const config = getConfig();
    const model = config.summaryModel;
    const t0 = Date.now();
    const { content, usage } = await llmSummarize(prompt);
    const durationMs = Date.now() - t0;
    const costUsd = calcCostUsd(model, usage.inputTokens, usage.outputTokens);
    return { summary: content, usage, costUsd, model, durationMs };
  } catch {
    return { summary: status === "passed" ? "All steps passed." : "Test failed. Review video/logs." };
  }
}
