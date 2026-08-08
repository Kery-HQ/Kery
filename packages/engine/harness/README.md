# Local benchmark harness

Runs the **real** engine (`runOrchestratedJob`) against locally served apps with
an in-memory storage adapter, and scores the result against planted bugs. A full
3-case sweep takes ~15 minutes and costs ~$1, versus ~25 minutes per single case
through the cloud.

## Why

Cloud iteration (commit → deploy → Vercel preview → CI run) is ~25 minutes and
depends on build quotas. This loop removes deploys, previews and queues from the
critical path, so an engine or prompt change can be measured immediately — and
scored automatically instead of read by eye.

## Run it

```bash
# 1. serve the benchmark apps (branches with planted bugs)
~/Documents/repo/harness-serve.sh

# 2. run the suite
cd packages/engine
OPENAI_API_KEY=… node harness/run-benchmark.mjs \
  --suite ~/Documents/repo/harness-suite.json \
  --mode review \        # review = real pipeline (diff → plan → run); scripted = hand-written plan (ceiling)
  --repeat 2 \           # ALWAYS repeat: the benchmark models run at temperature 1.0, single runs are noisy
  --label my-change
```

Results land in `harness-results/<label>-<timestamp>.json` with per-bug scoring,
the generated plan, cost, steps and the verification record.

## Modes

- `--mode scripted` — uses the suite's hand-written intent. Measures the
  **agent's ceiling**: what it catches when the plan is already perfect.
## Environment

- `OPENAI_API_KEY` — required.
- `KERY_PR_REVIEW_PATH` — required for `--mode review` only: absolute path to the
  cloud worker's built `prReview.js`. The review pass lives in the Kery-Cloud
  repo, so this loop can only measure plan quality when that repo is present and
  built. Without it, `--mode scripted` (the ceiling) still runs.
- Apps must be served first — see `serve-apps.sh`. Note purchasify needs a
  `.env.local`, since its middleware builds a Supabase client on every request
  and returns 500 on all routes without one.

## Held-out case

`purchasify-licences` is flagged `heldOut` in `suite.json`. Its per-bug results
and score are hidden unless `--reveal` is passed, and it is excluded from the
headline total. This is mechanical on purpose: a held-out case only detects
overfitting while the person tuning the prompt cannot see which of its bugs are
missed. Reveal it only when you have stopped changing the prompt.

- `--mode review` — calls the same `reviewPullRequest` the cloud CI uses to turn
  a diff into a test plan. Measures the **real pipeline**, and is what you
  iterate against when improving plan generation.

The gap between the two is plan quality, and it has been the dominant term.

## Reading results

`caught/planted` per case, plus which bug classes failed. Always compare across
**all** cases: a prompt change that lifts one app while wrecking another looks
like a win on a single case (this happened — see `review-v3`).

## Adding a case

Add to `harness-suite.json`: `baseUrl`, an `intent` (the scripted ceiling), the
`diffFile` for review mode, and `plantedBugs[]` where each `detect` is a list of
regexes that must ALL match one finding (or one contradicted verification).
Keep the regexes behaviour-based, not phrasing-specific.
