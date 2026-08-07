# What actually improved the tester (night of 2026-08-05/06)

Short version: **two structural bugs, not prompt wording.** Seven prompt
rewrites moved nothing. Fixing what the model could *see*, and how many checks
it was allowed to write, took plan quality from 67% to 80%.

## The plateau, and why it was invisible

Seven review-prompt configurations scored between 44% and 56% end-to-end with
no trend, the earliest tied for best. Per-bug, the picture was frozen: the same
four bugs always caught, the same four never, across very different prompts.

Two separate mistakes kept this hidden.

**1. The scorer lied.** Detection was regex-based. A run reported the row order
"remains GPT-4o mini" while the pattern list wanted "unchanged", so a real catch
scored zero. Every historical comparison was distorted; rescoring with an LLM
judge showed the apparent v2-to-v3 regression never existed. Fixed by
`judge.mjs`.

**2. The measurement could not resolve the change.** Each end-to-end run costs
~5 minutes and ~$0.50 and stacks browser-execution variance on top of plan
quality. The same config scored 1/3 then 2/3 on the same case. At n=18, a
one-bug difference is noise, and I was reading noise as signal for seven rounds.

Fixed by `score-plans.mjs`: one cheap call per (plan, bug) asking whether
executing that plan would expose that defect, with no browser. ~100x cheaper,
which buys the repeats needed to separate signal from noise. It is a proxy, but
a fair one — the scripted ceiling reaches 94% end-to-end on hand-written plans,
so execution is not the binding constraint.

## The root cause

`MAX_PATCH_CHARS_PER_FILE` was 1,200. The benchmark diffs are 7,400-12,200
characters, nearly all in one new component file — the common shape of a feature
PR. The defective lines sat at characters 1,929, 3,301 and 5,637.

**Every one was outside the window.** The review model had never seen the bugs
it was being asked to find. No amount of prompt wording could have fixed that,
which is exactly why no amount of it did.

## What the fast loop showed

| config | change | plan exposure |
|---|---|---|
| v7 | disagreement-hunting prompt, truncated diff | 30/45 (67%) |
| v8 | + force checks into one journey | 21/45 (47%) — reverted |
| v10 | + full diff visible | 32/45 (71%) |
| v11 | + plan cap 6 → 8 | **36/45 (80%)** |

Both bugs that no review configuration had *ever* caught became reliable:
`counter-ignores-vision-filter` 1/5 → 5/5, `invalid-promo-keeps-discount`
0/5 → 4/5.

v8 is the clearest argument for the fast loop: it was measured and reverted in
five minutes without a browser run. Under the old loop that is an hour spent
for an ambiguous answer.

## Prompt changes that did survive

Grounded in measurement and literature rather than intuition:

- **Disagreement-hunting** — every persistently-missed bug is two expressions in
  the diff that must agree and do not: an error message claiming "between 1 and
  20" against a check enforcing only `limit < 1`; a list filtered on two fields
  against a counter using one; a success path clearing state where the failure
  path does not. Earlier iterations all told the model *how to write* a check;
  none told it *where to look*.
- **RIPR** (Cleverest, arXiv:2501.11086) — a check exposes a defect only if it
  Reaches the changed code, Infects state with inputs where correct and buggy
  differ, Propagates that to the screen, and Reveals it precisely.
- **Near-miss inputs** — the value just outside a stated rule, not an obviously
  invalid one. Correct and broken code both reject "not-an-email".
- **A `setup` slot and relational assertions** (WebTestPilot, arXiv:2602.11724,
  which reports 96% vs 26% precision for relational over standalone oracles).

## Things that did NOT work

- "Use exact literal values" (v3, v4). Structural diffing showed generated plans
  already carried *more* numbers than the 94% hand-written ones (18-34 vs 7-13).
  It addressed a deficiency that never existed.
- Targeting specific failing bug classes (v3, v5). Zero-sum against the check
  cap: v3 helped one app's validation bug and took chatific from 3/3 to 1/3.
- Forcing checks into a single journey (v8). Compressed away the concrete values.

## Guardrails now in place

- **Held-out case** (`purchasify-licences`) with mechanically hidden scores. A
  held-out case only detects overfitting while the tuner cannot see which of its
  bugs are missed, so `--reveal` is required and it is excluded from headline
  totals. Its three planted bugs were each verified reproducible in a browser
  before being trusted as ground truth.
- **Per-bug regression detection** (`compare.mjs`), compared only against
  same-mode configs. The headline total is what hid the v3 regression.

## End-to-end confirmation

Plan exposure predicted the outcome. Running v11 end to end, n=2 per case:

| config | tuning set |
|---|---|
| v4 | 9/18 (50%) |
| v6 | 8/18 (44%) |
| v7 | 8/18 (44%) |
| **v11** | **14/18 (78%)** |
| scripted ceiling | 17/18 (94%) |

Per case: purchasify 5/6, noted-so 4/6, chatific 5/6. noted-so had never
exceeded 1/6 under any earlier configuration.

Five bugs improved; one regressed (`email-regex` 1/2 -> 0/2). The stated gate
was "total up AND no per-bug regression", so strictly v11 does not pass it. The
trade is recommended anyway — five gains against one loss, on the single bug
that plan scoring independently shows at 0/5 — but that is a judgement call,
not the rule being met.

**Held-out: 4/6 (67%)**, revealed only after prompt changes stopped. Its bug
shapes — pagination, localStorage persistence, a wrong disabled-guard — appear
nowhere in the tuning set, and one of the two runs caught all three. Held-out
slightly below tuning is the healthy pattern; it indicates generalisation
rather than fitting to three apps. One held-out run ended `failed` at 11 steps,
so its 1/3 is an early abort rather than a fair score.

## Open

- `email-regex-accepts-no-tld` is still 0/5 at plan level — the only planted bug
  no configuration exposes.
- Cost per run rose to ~$0.50-0.80 against a $0.18 target. Richer plans and
  larger step budgets both cost money; this needs a decision, not a default.
- Plan exposure is a proxy. End-to-end validation of v11 is the confirming
  measurement.

## 2026-08-07 — Hand-triage of the 4-label spread (all 80 reports verified in a browser)

Every reported issue from `all-clean-0/1/2` (69) and `all-real` (11) was
reproduced or refuted by hand against the running apps. This is the first
measurement of what the noise number actually MEANS.

**Headline: the clean corpus is not clean, and the biggest noise families were
the engine misinforming the agent — not the agent's judgement.**

| Family | Count | Verdict | Cause |
|---|---|---|---|
| TEAM15 promo "rejected" | 6 | NOISE | Empty input rendered as `textbox "TEAM15"` — placeholder used as accessible name, no value shown. Agent clicked Apply without typing. Deterministic across all passes. |
| "App truncates input to 50 chars" | 2 | NOISE | The TREE truncates displayed values at 50 chars; agent read its own display cap as an app bug. |
| "No confirmation after Export/Send" | 6 | NOISE | `alert()` auto-accepted silently; agent never told a dialog appeared. |
| Stepper "miswired" (wrong row changed) | 3 | ENGINE BUG (real, ours) | First-match bbox disambiguation clicked the adjacent row's identical +/− button. |
| Interaction failures blamed on app (selects, checkboxes, domChanged=NO) | ~10 | NOISE | Engine failed to drive the control, then reported the app unresponsive. Native select/checkbox work by hand. |
| Plan-invented URLs (…/bookflow/checkout.html 404) | 4 | NOISE | Plan derived a route from a diff file path. |
| "Two rapid clicks made two orders" | 2 | NOISE | Agent's clicks are seconds apart; the app's rapid-click guard is fine. Second deliberate click after confirmation = second order. |
| Sync save "lacks Saving… state" | 3 | NOISE (invented requirement) | Save is synchronous; expecting a processing state is invented. |
| Misread number (310 → "31") | 1 | NOISE | Total units 535 is correct; agent dropped a digit and invented a 279-unit discrepancy. |
| ToS "unrelated AI text" | 1 | NOISE | The AI-testing warranty clause is Kery's own product domain. |
| HTML injection in tickets page | 6 | REAL | `status.innerHTML = ... ${name}` — renders user markup. Unplanned real bug in the "clean" corpus. |
| Stale validation/toast state | 8 | REAL | Errors persist after correction; success toast survives filter changes; "Closed 0" green toast. |
| A11y naming gaps | 7 | REAL | Unnamed spinbuttons, +/− only names, concatenated select labels, #a1a1aa contrast. |
| Misc real (−$0.00, phone accepts spaces, select-all state) | ~5 | REAL | Verified in source or by hand. |
| kery.dev live defects | 8 | REAL | #demo anchor under fixed header (scroll-margin-top:0), blog article title not a link, FAQ item doesn't expand, hero pill flicker. |
| Transient/debatable | ~4 | DEBATABLE | Search-lag (self-corrects, token-guarded), video-proof link (element absent at rest). |

Roughly: **~35 real, ~40 noise, ~5 debatable.** The raw "noise per run" number
overstates noise by ~2× because the corpus has real bugs in it.

**Fixes shipped (fixv1), all mechanical, no judgement-prompt changes:**
1. a11yTree: text controls always render `value="…"` (empty string included);
   placeholder-derived names render as `placeholder "…"`; truncated values carry
   `(display truncated; actual length N)`.
2. agent: auto-accepted dialogs surfaced in the next observation.
3. a11yTree: bbox disambiguation picks the NEAREST candidate, not first-within-
   tolerance (both named-dup and unnamed paths).
4. prReview plan rule: never derive URLs from diff file paths.

Measurement protocol for fixv1: per-family comparison, not totals — the real
findings (injection, stale state, a11y) SHOULD keep appearing; only the noise
families above should disappear.

### fixv1 measurement — the resolver "fix" was itself a regression

| Axis | Baseline | fixv1 |
|---|---|---|
| Detection (12 cases, tuning) | 129/216 = **60%** (detband, repeat 6) | 29/72 = **40%** (repeat 2) |
| Noise per run (clean corpus) | 2.55 mean (3 passes) | 2.22 / 2.78 (2 passes) |

Noise was flat and detection fell 20 points. The cause was not the agent: mean
steps per run collapsed on four cases (notedso 72.5 → 10.0, chatific 21.3 → 4.0,
gridworks-queue 22.3 → 10.5) with checks marked `not_testable` because the run
could not get past a control it used to operate.

**The bug was in fix #3.** Acceptance had been per-axis —
`|dx| < 50 && |dy| < 50`, a 100×100 square. Rewriting it as
`Math.hypot(dx, dy) < 50` silently replaced that square with its inscribed
circle, so an element at dx=40, dy=40 (distance 56) stopped resolving and fell
through to `locator.first()` — the precise mis-click the change was meant to
prevent, now firing on more elements.

Corrected in fixv2: the per-axis tolerance is restored as the ACCEPTANCE test,
and nearest-distance only chooses AMONG the candidates that pass it. Both bbox
paths (unnamed, tolerance 15; named-duplicate, tolerance 50).

**Lesson worth keeping: a change to element resolution is a change to
detection.** It cannot be validated on the noise axis alone — noise stayed flat
across a 20-point detection collapse, because a run that dies early reports
fewer of everything.
