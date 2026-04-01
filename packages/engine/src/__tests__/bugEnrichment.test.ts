/**
 * Tests for bugEnrichment — enrichBugsForRun()
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichBugsForRun } from "../bugEnrichment.js";

describe("enrichBugsForRun", () => {
  it("enriches agent bug steps into Bug records", () => {
    const bugs = enrichBugsForRun("run-1", "2026-01-01T00:00:00Z", "test", [
      { index: 1, action: "bug", reasoning: "Button overlaps footer", bugType: "visual", severity: "medium", url: "http://app/page" },
    ]);
    assert.strictEqual(bugs.length, 1);
    assert.strictEqual(bugs[0].category, "visual");
    assert.strictEqual(bugs[0].severity, "medium");
    assert.ok(bugs[0].name.includes("Button overlaps"));
  });

  it("deduplicates identical bugs", () => {
    const raw = [
      { reasoning: "Button overlaps footer", bugType: "visual" as const, url: "http://app/page" },
      { reasoning: "Button overlaps footer", bugType: "visual" as const, url: "http://app/page" },
    ];
    const bugs = enrichBugsForRun("run-1", "2026-01-01T00:00:00Z", null, raw);
    assert.strictEqual(bugs.length, 1, "Duplicate bugs should be deduped");
  });

  it("deduplicates fuzzy-similar bugs", () => {
    const raw = [
      { reasoning: "The submit button overlaps the page footer", bugType: "visual" as const, url: "http://app/page" },
      { reasoning: "Submit button overlapping page footer area", bugType: "visual" as const, url: "http://app/page" },
    ];
    const bugs = enrichBugsForRun("run-1", "2026-01-01T00:00:00Z", null, raw);
    assert.strictEqual(bugs.length, 1, "Fuzzy-similar bugs should be deduped");
  });

  it("returns empty array for null/undefined input", () => {
    assert.deepStrictEqual(enrichBugsForRun("r", "d", null, null), []);
    assert.deepStrictEqual(enrichBugsForRun("r", "d", null, undefined), []);
    assert.deepStrictEqual(enrichBugsForRun("r", "d", null, []), []);
  });

  it("truncates long titles", () => {
    const longReason = "A".repeat(200);
    const bugs = enrichBugsForRun("run-1", "2026-01-01T00:00:00Z", null, [
      { reasoning: longReason, bugType: "ux" as const },
    ]);
    assert.ok(bugs[0].name.length <= 81, "Title should be truncated"); // 80 + ellipsis
  });

  it("uses a shorter title than full description when a sentence break exists", () => {
    const bugs = enrichBugsForRun("run-1", "2026-01-01T00:00:00Z", null, [
      {
        reasoning: "Login button has low contrast. The WCAG ratio is below 4.5:1 on the gray background.",
        bugType: "visual" as const,
      },
    ]);
    assert.ok(bugs[0].name.length < bugs[0].description.length, "Title should be shorter than description");
    assert.ok(bugs[0].name.includes("Login"), "Title should reflect first sentence");
  });
});
