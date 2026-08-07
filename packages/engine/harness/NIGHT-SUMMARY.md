# Overnight noise-reduction — summary

Goal: reduce false-positive issues as far as possible with **no detection
regression**, everything local, nothing pushed. Backups: `backup/night-noise-0808`
in Kery and Kery-Cloud.

## What was wrong with the last measurement

Three demo apps (purchasify, noted-so, chatific) were serving stale builds whose
CSS/JS all 404'd — the agent was testing unstyled, non-interactive pages and
correctly reporting "the button does nothing". That faked a 10-point detection
regression. All six apps were rebuilt and asset-verified before any measurement.

## Hand-triage of the clean corpus (33 reports, 18 runs)

REAL 15 / NOISE 18. Crucially, **8 of the 18 noise reports were the engine's
fault**, not the model's judgement — see TRIAGE-fixv3.md. That is what made this
attackable mechanically instead of by prompt-wrangling.

## Engine fixes (all deterministically verified, all committed locally)

1. **Hidden elements offered as controls** — `buildTree` walked every node with
   no visibility test, so closed modals / collapsed menus / inactive tabs were
   handed to the agent; it clicked one, Playwright timed out, run reported the
   control as dead. Added an `isRendered()` gate.
   *Measured:* the hidden-dialog family fell from 3 reports/18 runs to 1/36.

2. **Dialogs not on the step record** — `alert()` confirmations reached the
   navigator but not the record the reviewers grade, so a real "Report sent."
   was reported as no-confirmation, citing a different button's alert. Dialog is
   now stamped on the step that raised it.

3. **Repetition counted without checking response** — pressing a stepper 7×
   legitimately looked identical to a jammed control; 4 such warnings auto-file
   a high-severity "control does nothing" bug. Now only inert repeats count.
   Covered by loopDetection.test.ts (7 tests incl. intermittent control).

4. **Native toggle state unreadable** — found by the component zoo (below). The
   extractor read only `aria-checked`; native checkbox/radio carry none, so the
   agent could not tell if any box was ticked. Now reads the `.checked`
   property and states the off-position explicitly. Covered by a11yTree.test.ts.

## Component zoo (new experiment)

Every common control built in **plain HTML, React, Vue, Bootstrap**; a
deterministic probe (`zoo-probe.mjs`) drives each through the engine's real
perceive / state / value / action path. Before fix #4: state axis 0/8. After:
**53/53 across all four frameworks and all four axes.**

## Noise, measured

| Build | noise/run (clean corpus) |
|---|---|
| fixv3 (pre-night) | 1.83 |
| + visibility fix (visfix) | 1.64 |
| + dialog + repetition + state (v6) | measuring |

Detection (12 cases) measuring in v6 on repaired apps; the guardrail is that
none of these fixes can cost real detections — visibility only removes
unreachable nodes, repetition still trips on genuinely dead controls, state and
dialog only ADD truthful evidence.

## New corpus surfaces added (all verified correct in-browser)

- `clean/gridworks/workspace.html` — tabs, accordion, dropdown menu (the
  hidden-markup pattern fix #1 targets).
- `zoo/{plain,react,vue,bootstrap}.html` — the component matrix.

## Staged but NOT applied (kept out so v6 attribution stays clean)

- Invented-requirements verifier rule (`/tmp/v6-precondition-rule.txt`): grade a
  conditional claim not_testable when its trigger never occurred (the B10 class:
  shipped 19 of 20, reported the on-hand guard broken while quoting its own
  correct numbers). To be measured on both axes as v7, since prior prompt-level
  attempts at this family each cost ~20 detection points.
