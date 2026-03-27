# Batch Fix Checklist — 27-03-2026

## P0 — Critical

- [x] **#1** No run queue — add BullMQ + Redis, auto-detect concurrency (API/infra) — Added BullMQ worker with auto-detected concurrency based on available memory, Redis service in docker-compose, and queue-based run dispatch replacing setImmediate.
- [x] **#3** No transaction safety on run completion — wrap in BEGIN/COMMIT (DB adapter) — Added withTransaction() helper to StorageAdapter/PostgresAdapter, wrapped all post-run writes in atomic transaction.
- [x] **#4** Credentials stored in plaintext — AES-256-GCM with ENCRYPTION_KEY env var (DB adapter) — Added AES-256-GCM encrypt/decrypt for sensitive auth fields (password, token, apiKey), backwards-compatible when ENCRYPTION_KEY unset.
- [x] **#5** No token refresh — add refreshIfNeeded() for Clerk/Supabase (engine) — Added refreshIfNeeded() called before each Navigator step; refreshes Clerk JWTs and Supabase tokens with 60s buffer using refresh_token grant.

## P1 — High

- [x] **#6** buildAppTree() N+1 queries — batch INSERT ON CONFLICT (DB adapter) — Replaced per-page SELECT+INSERT/UPDATE loop with single batch INSERT ... ON CONFLICT DO UPDATE.
- [x] **#7** Memory save loops — multi-row INSERT (DB adapter) — Replaced per-entry INSERT loops with single multi-row INSERT and batch UPDATE with ANY($1) for boostConfidence.
- [x] **#8** listBugs() fetches screenshot blobs — exclude column, add endpoint (DB adapter + API) — Excluded screenshot_base64 from listBugs SELECT, added getBugScreenshot() method and /api/bugs/:bugId/screenshot endpoint.
- [x] **#9** Missing composite DB indexes — add 4 indexes (DB) — Added migration 003 with 4 composite indexes on test_runs, run_coverage, bugs, and memory_entries.
- [x] **#10** 401/403 not intercepted — auth-aware error classification (engine) — Network monitor now detects token auth sessions and triggers refresh on first 401/403 before reporting as bug.
- [x] **#11** Stagehand circuit breaker no recovery — add half-open timer (engine) — Circuit breaker now transitions to half-open after 30s, allowing a probe request to recover from transient failures.
- [x] **#12** Context amnesia — add rolling testing progress summary (engine) — Added ProgressSummary class that tracks pages visited, actions completed, bugs found, and failed attempts; injected into system prompt each step to survive conversation pruning.
- [x] **#13** No graceful shutdown — SIGTERM handler (API) — Added in #1: SIGTERM/SIGINT handler closes BullMQ worker, queue, HTTP server, and DB pool.
- [x] **#14** `as any` x46 in API routes — add Zod schemas (API) — Added shared Zod param schemas (params.ts), replaced all route param/body `as any` casts with validated parsing. Remaining 5 are pool access (#29) and Fastify SSE flush.
- [x] **#15** API Token auth mode unimplemented — page.route() header injection (engine) — Implemented apiToken auth mode using page.route('**/*') header injection with configurable headerName and headerPrefix.
- [x] **#43** Bounding boxes miss interactive controls — expand roles + getImplicitRole (engine) — Added 15 missing INTERACTIVE_ROLES and extended getImplicitRole to detect summary, contenteditable, onclick, tabindex elements as interactive.
- [x] **#44** Review agent sees green boxes as bugs — return clean screenshot separately (engine) — takeStableSnapshot now returns both marked and clean screenshots; review agent and bug storage use clean version. Added defense-in-depth prompt note.
- [x] **#45** Video recording broken with Stagehand — explicit save, error handling (engine) — Added explicit page.video().path() + copyFile before Stagehand destroy, replaced .catch(()=>{}) with logged warnings, added missing .webm detection logging.
- [x] **#46** Bug screenshots not attached — fix step index mismatch (engine) — Fixed by keying screenshots by agent step.index in onStep callback (for navigator bugs) and by screenshotSeq in onScreenshot (for review bugs).
- [x] **#47** Run detail page lacks agent observability — per-step screenshots, a11y tree, LLM prompts, agent flow view (web) — Enhanced Steps tab with per-step LLM call correlation (prompt, response, screenshot, model, cost, tokens, duration), per-step cost display, and expandable agent decision view.

## P2 — Medium

- [x] **#16** Vision token overhead — skip screenshot when page unchanged (engine) — Added simpleDomHash comparison between steps; onScreenshot only fires when URL+DOM content changes.
- [x] **#17** A11y tree slow on complex pages — cache + prune (engine) — Added domHash-keyed LRU cache (max 20 entries) for extractA11yTree; cache hit skips full re-extraction.
- [x] **#18** Review Agent screenshot buffer — add backpressure (engine) — Added REVIEW_BUFFER_MAX (20) limit; drops oldest queued entries when exceeded.
- [x] **#19** No memory pruning — TTL + confidence decay (engine) — Added decayAndPrune() with 14-day TTL decay and confidence floor of 10; entries below threshold are pruned.
- [x] **#20** No video/screenshot cleanup — delete on run deletion (API) — Added DELETE /api/runs/:runId endpoint that removes video file, screenshot directory, bugs, and DB row.
- [x] **#21** Weak iframe support — improve detection + reporting (engine) — Replaced silent catch-ignore with explicit per-iframe logging of success/failure counts and frame URLs.
- [x] **#22** No request idempotency — add idempotency key (API) — Added Idempotency-Key header support on POST /run with 30s TTL dedup cache.
- [x] **#24** Navigator prompt missing error recovery — add guidance (engine) — Added error recovery instructions to system prompt (retry with different selector, keyboard fallback).
- [x] **#25** Navigator prompt missing form validation testing — add guidance (engine) — Added form validation testing guidance to system prompt (empty fields, invalid values, then happy path).
- [x] **#26** Review Agent narrow bug categories — add a11y, perf, data (engine) — Added a11y, performance, and data integrity categories to review prompt and response parsing.
- [ ] **#27** Path Generator shallow plans — remove step limit, full coverage plans (engine)
- [ ] **#28** Path Generator not prioritized — happy paths first (engine)
- [ ] **#29** StorageAdapter bypassed — add missing methods (DB adapter)
- [ ] **#30** Summarizer lacks actionability — structured recommendations (engine)
- [ ] **#31** Login-page detection missing in crawler (engine)
- [ ] **#32** Regression replay silent auth failure — retry auth (engine)
- [ ] **#33** No test suite — focused tests for high-risk modules (engine)
- [ ] **#34** Memory formatting weak signal-to-noise — temporal + usage context (engine)

## P3 — Low

- [x] **#35** Regression stale detection too aggressive (engine) — Increased consecutive stale threshold from 3 to 5, added >50% stale ratio check, and track per-step staleness.
- [x] **#36** Bug name dedup unreliable (engine) — Added trigram-based fuzzy name similarity (>0.7 threshold) alongside exact tuple dedup, with normalized name stripping punctuation, whitespace, and stop-words.
- [x] **#37** No 2FA/MFA support (engine) — Added totp_secret to AuthConfig, TOTP code generation (RFC 6238 HMAC-SHA1), 2FA screen detection via page text indicators, and auto-fill handler.
- [x] **#38** OAuth 2.0 unimplemented (engine) — Added injectOAuthToken() supporting pre-obtained access_token injection via cookie, localStorage, or header interception.
- [x] **#39** No cross-agent communication during run (engine) — Added getCompletedBugs() to ReviewProcessor and cross-agent feedback loop in orchestrator's onStep callback that feeds review bugs back to navigator context mid-run.
- [ ] **#40** No prompt injection sanitization (engine)
- [ ] **#41** Screenshot quality too low for review (engine)
- [ ] **#42** No structured logging/observability (API/infra)

---

**Total: 45 items** — 4 P0, 15 P1, 18 P2, 8 P3
