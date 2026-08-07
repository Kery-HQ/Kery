import { test } from "node:test";
import assert from "node:assert/strict";
import { detectActionRepetition } from "../agent.js";

/**
 * Repetition is only evidence of being stuck when the page did not respond.
 *
 * Counting bare repeats made the engine manufacture false bugs: pressing a
 * quantity stepper seven times, paging through a list, or adding several
 * attendees all look identical to a jammed control if you ignore whether
 * anything changed. The advisory told the agent the control was inert while the
 * count was visibly moving, and four consecutive warnings auto-file a
 * high-severity "control does nothing" report.
 */

const click = (changedPage: boolean | undefined, element = 7) => ({
  action: "click", element, elementName: "−", changedPage,
});

test("a control that responds every time is never a stuck loop", () => {
  const seven = Array.from({ length: 7 }, () => click(true));
  assert.equal(detectActionRepetition(seven).stuck, false);
});

test("a genuinely inert control is still caught at the threshold", () => {
  const three = Array.from({ length: 3 }, () => click(false));
  const result = detectActionRepetition(three);
  assert.equal(result.stuck, true);
  assert.equal(result.repeatCount, 3);
});

test("two inert presses are below the threshold", () => {
  assert.equal(detectActionRepetition([click(false), click(false)]).stuck, false);
});

test("responsive presses do not top up an inert count", () => {
  // Two dead presses plus live ones must not reach the threshold: otherwise a
  // control that works intermittently gets reported as broken.
  const mixed = [click(false), click(true), click(false), click(true), click(true)];
  assert.equal(detectActionRepetition(mixed).stuck, false);
});

test("an unresolved verdict is not counted either way", () => {
  // changedPage is undefined until the next iteration compares DOM hashes.
  const pending = Array.from({ length: 5 }, () => click(undefined));
  assert.equal(detectActionRepetition(pending).stuck, false);
});

test("distinct inert controls are not conflated", () => {
  const different = [click(false, 1), click(false, 2), click(false, 3)];
  assert.equal(detectActionRepetition(different).stuck, false);
});

test("assert and wait never count toward a loop", () => {
  const exempt = Array.from({ length: 5 }, () => ({ action: "assert", element: 7, elementName: "−", changedPage: false }));
  assert.equal(detectActionRepetition(exempt).stuck, false);
});
