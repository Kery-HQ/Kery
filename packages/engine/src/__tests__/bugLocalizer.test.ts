/**
 * Tests for bugLocalizer — the safety contract that matters: it never makes an
 * LLM call (or mutates bugs) when there's nothing valid to localize, and it is
 * fully disableable. The happy-path zoom quality is covered by the harness
 * (harness/localize-check.mjs), which needs a live vision model.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { localizeBugRegions } from "../bugLocalizer.js";

const origFlag = process.env.KERY_LOCALIZE;
afterEach(() => {
  if (origFlag === undefined) delete process.env.KERY_LOCALIZE;
  else process.env.KERY_LOCALIZE = origFlag;
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
});
