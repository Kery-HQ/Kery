/**
 * Tests for bugLocalizer — the safety contract that matters: it never makes an
 * LLM call (or mutates bugs) when there's nothing valid to localize, and it is
 * fully disableable. The happy-path zoom quality is covered by the harness
 * (harness/localize-check.mjs), which needs a live vision model.
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { localizeBugRegions } from "../bugLocalizer.js";
import { initEngineConfig } from "../config.js";

const origFlag = process.env.KERY_LOCALIZE;
afterEach(() => {
  if (origFlag === undefined) delete process.env.KERY_LOCALIZE;
  else process.env.KERY_LOCALIZE = origFlag;
});

beforeEach(() => {
  initEngineConfig({
    openaiApiKey: "",
    openrouterApiKey: "",
    anthropicApiKey: "",
    geminiApiKey: "",
    agentModel: "openai/gpt-4o-mini",
    auxiliaryModel: "openai/gpt-4o-mini",
    reviewAgentModel: "openai/gpt-4o-mini",
    stagehandEnabled: false,
    stagehandModel: "openai/gpt-4o-mini",
    runTimeoutMinutes: 1,
    llmTimeoutMs: 1000,
    reviewTimeoutMs: 1000,
  });
});

describe("localizeBugRegions", () => {
  it("is a no-op when disabled (KERY_LOCALIZE=0)", async () => {
    process.env.KERY_LOCALIZE = "0";
    const bug: any = { action: "bug", source: "navigator", reasoning: "x", screenshotBase64: "abc" };
    const res = await localizeBugRegions([bug]);
    assert.equal(res.localized, 0);
    assert.equal(bug.region, undefined);
  });

  it("makes no call when there are no candidates", async () => {
    process.env.KERY_LOCALIZE = "1";
    // No screenshot → not a candidate; a call here would throw (no LLM configured).
    const noShot: any = { action: "bug", source: "navigator", reasoning: "x" };
    // Already has a valid region → nothing to do.
    const hasRegion: any = { action: "bug", source: "filmstrip", reasoning: "x", screenshotBase64: "abc", region: { x: 10, y: 10, w: 100, h: 50 } };
    // Screenshot is a URL/path, not base64 → skip.
    const urlShot: any = { action: "bug", source: "navigator", reasoning: "x", screenshotBase64: "/api/runs/1/bug-0.jpg" };
    // No defect text → nothing to search for.
    const noText: any = { action: "bug", source: "navigator", screenshotBase64: "abc" };
    const res = await localizeBugRegions([noShot, hasRegion, urlShot, noText]);
    assert.equal(res.localized, 0);
    assert.equal(hasRegion.region.w, 100, "existing region left untouched");
  });

  it("localizes check candidates in the same batch after bugs", async () => {
    process.env.KERY_LOCALIZE = "1";
    const bug: any = { action: "bug", source: "navigator", reasoning: "Save button does nothing", screenshotBase64: "YnVn" };
    const verified: any = {
      title: "Saving a task",
      claim: "Saving a task shows it in the list",
      status: "verified",
      evidence: "Step 3 showed the new task row.",
      screenshotBase64: "Y2hlY2s=",
    };
    const notTestable: any = {
      claim: "Deleting a task removes it",
      status: "not_testable",
      evidence: "The delete action was not attempted.",
      screenshotBase64: "bm90",
    };
    let promptText = "";
    const res = await localizeBugRegions([bug], {
      verifications: [verified, notTestable],
      __test: {
        drawGridOnScreenshot: async (buf: Buffer) => buf,
        llmChat: async (messages: any[]) => {
          promptText = messages[1].content[0].text;
          assert.equal(messages[1].content.length, 3, "one text part plus bug and check images");
          return {
            content: JSON.stringify({
              regions: [
                { index: 0, region: { x: 10, y: 20, w: 30, h: 40 } },
                { index: 1, region: { x: 100, y: 200, w: 150, h: 120 } },
              ],
            }),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as any;
        },
      },
    });

    assert.equal(res.localized, 2);
    assert.equal(res.localizedBugs, 1);
    assert.equal(res.localizedChecks, 1);
    assert.deepEqual(bug.region, { x: 10, y: 20, w: 30, h: 40 });
    assert.deepEqual(verified.region, { x: 100, y: 200, w: 150, h: 120 });
    assert.equal(notTestable.region, undefined);
    assert.match(promptText, /Reported problem: Save button does nothing/);
    assert.match(promptText, /Verification item: box the specific visible element or area that proves this claim is true/);
  });

  it("prioritizes bug candidates when the combined cap is reached", async () => {
    process.env.KERY_LOCALIZE = "1";
    const bugs = Array.from({ length: 12 }, (_, i) => ({
      action: "bug",
      source: "navigator",
      reasoning: `Bug ${i}`,
      screenshotBase64: Buffer.from(`bug-${i}`).toString("base64"),
    })) as any[];
    const check: any = {
      claim: "The task is created",
      status: "verified",
      evidence: "The row appeared.",
      screenshotBase64: Buffer.from("check").toString("base64"),
    };
    let imageParts = 0;

    const res = await localizeBugRegions(bugs, {
      verifications: [check],
      __test: {
        drawGridOnScreenshot: async (buf: Buffer) => buf,
        llmChat: async (messages: any[]) => {
          imageParts = messages[1].content.filter((part: any) => part.type === "image_url").length;
          return { content: `{"regions":[]}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any;
        },
      },
    });

    assert.equal(res.localized, 0);
    assert.equal(imageParts, 12);
    assert.equal(check.region, undefined);
  });
});
