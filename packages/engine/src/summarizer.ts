import { geminiSummarize } from "./gemini.js";

export async function summarizeRun(intent: string, status: string, steps: string[], videoUrl?: string) {
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
    return await geminiSummarize(prompt);
  } catch {
    return status === "passed" ? "All steps passed." : "Test failed. Review video/logs.";
  }
}
