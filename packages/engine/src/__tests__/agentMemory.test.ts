/**
 * Tests for agentMemory — formatMemoryForPrompt and proposeMemoriesFromRun
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMemoryForPrompt, proposeMemoriesFromRun } from "../agentMemory.js";
import type { MemoryEntry } from "../agentMemory.js";

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "test-id",
    scope: "project",
    type: "learned_path",
    summary: "Test summary",
    content: "Test content",
    confidence: 60,
    source: "agent",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as MemoryEntry;
}

describe("formatMemoryForPrompt", () => {
  it("returns empty string for no entries", () => {
    assert.strictEqual(formatMemoryForPrompt([]), "");
  });

  it("formats entries grouped by type", () => {
    const entries = [
      makeEntry({ type: "learned_path", summary: "Login flow", content: "click login → fill email" }),
      makeEntry({ type: "tip", summary: "Use tab", content: "Tab key works better than click" }),
    ];
    const result = formatMemoryForPrompt(entries);
    assert.ok(result.includes("AGENT MEMORY"), "Should have header");
    assert.ok(result.includes("Learned paths"), "Should have paths section");
    assert.ok(result.includes("Tips and hints"), "Should have tips section");
    assert.ok(result.includes("Login flow"), "Should include summary");
  });

  it("marks high and low confidence entries", () => {
    const entries = [
      makeEntry({ confidence: 90, summary: "High conf" }),
      makeEntry({ confidence: 20, summary: "Low conf" }),
    ];
    const result = formatMemoryForPrompt(entries);
    assert.ok(result.includes("[HIGH confidence]"));
    assert.ok(result.includes("[low confidence]"));
  });
});

describe("proposeMemoriesFromRun", () => {
  it("proposes a learned_path from successful steps", () => {
    const steps = [
      { action: "click", target: "Login", status: "ok" },
      { action: "fill", target: "Email", status: "ok" },
      { action: "click", target: "Submit", status: "ok" },
      { action: "done", status: "ok" },
    ];
    const proposals = proposeMemoriesFromRun(steps, "Test login flow");
    assert.ok(proposals.length > 0, "Should propose at least one memory");
    const path = proposals.find(p => p.type === "learned_path");
    assert.ok(path, "Should have a learned_path proposal");
    assert.ok(path!.content.includes("click"), "Path should include actions");
  });

  it("proposes bug_pattern from failed steps", () => {
    const steps = [
      { action: "click", target: "Submit", status: "ok" },
      { action: "bug", target: "Error", status: "ok", bugType: "functional", severity: "high" },
      { action: "done", status: "ok" },
    ];
    const proposals = proposeMemoriesFromRun(steps, "Test submit");
    const bugPattern = proposals.find(p => p.type === "bug_pattern");
    assert.ok(bugPattern, "Should propose a bug_pattern");
  });

  it("returns empty for single-step runs", () => {
    const steps = [{ action: "done", status: "ok" }];
    const proposals = proposeMemoriesFromRun(steps, "Quick test");
    const path = proposals.find(p => p.type === "learned_path");
    assert.ok(!path, "Should not propose path for single step");
  });
});
