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

## Open

- `email-regex-accepts-no-tld` is still 0/5 at plan level — the only planted bug
  no configuration exposes.
- Cost per run rose to ~$0.50-0.80 against a $0.18 target. Richer plans and
  larger step budgets both cost money; this needs a decision, not a default.
- Plan exposure is a proxy. End-to-end validation of v11 is the confirming
  measurement.
