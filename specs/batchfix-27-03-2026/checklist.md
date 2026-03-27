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
- [ ] **#9** Missing composite DB indexes — add 4 indexes (DB)
- [ ] **#10** 401/403 not intercepted — auth-aware error classification (engine)
- [ ] **#11** Stagehand circuit breaker no recovery — add half-open timer (engine)
- [ ] **#12** Context amnesia — add rolling testing progress summary (engine)
- [ ] **#13** No graceful shutdown — SIGTERM handler (API)
- [ ] **#14** `as any` x46 in API routes — add Zod schemas (API)
- [ ] **#15** API Token auth mode unimplemented — page.route() header injection (engine)
- [ ] **#43** Bounding boxes miss interactive controls — expand roles + getImplicitRole (engine)
- [ ] **#44** Review agent sees green boxes as bugs — return clean screenshot separately (engine)
- [ ] **#45** Video recording broken with Stagehand — explicit save, error handling (engine)
- [ ] **#46** Bug screenshots not attached — fix step index mismatch (engine)
- [ ] **#47** Run detail page lacks agent observability — per-step screenshots, a11y tree, LLM prompts, agent flow view (web)

## P2 — Medium

- [ ] **#16** Vision token overhead — skip screenshot when page unchanged (engine)
- [ ] **#17** A11y tree slow on complex pages — cache + prune (engine)
- [ ] **#18** Review Agent screenshot buffer — add backpressure (engine)
- [ ] **#19** No memory pruning — TTL + confidence decay (engine)
- [ ] **#20** No video/screenshot cleanup — delete on run deletion (API)
- [ ] **#21** Weak iframe support — improve detection + reporting (engine)
- [ ] **#22** No request idempotency — add idempotency key (API)
- [ ] **#24** Navigator prompt missing error recovery — add guidance (engine)
- [ ] **#25** Navigator prompt missing form validation testing — add guidance (engine)
- [ ] **#26** Review Agent narrow bug categories — add a11y, perf, data (engine)
- [ ] **#27** Path Generator shallow plans — remove step limit, full coverage plans (engine)
- [ ] **#28** Path Generator not prioritized — happy paths first (engine)
- [ ] **#29** StorageAdapter bypassed — add missing methods (DB adapter)
- [ ] **#30** Summarizer lacks actionability — structured recommendations (engine)
- [ ] **#31** Login-page detection missing in crawler (engine)
- [ ] **#32** Regression replay silent auth failure — retry auth (engine)
- [ ] **#33** No test suite — focused tests for high-risk modules (engine)
- [ ] **#34** Memory formatting weak signal-to-noise — temporal + usage context (engine)

## P3 — Low

- [ ] **#35** Regression stale detection too aggressive (engine)
- [ ] **#36** Bug name dedup unreliable (engine)
- [ ] **#37** No 2FA/MFA support (engine)
- [ ] **#38** OAuth 2.0 unimplemented (engine)
- [ ] **#39** No cross-agent communication during run (engine)
- [ ] **#40** No prompt injection sanitization (engine)
- [ ] **#41** Screenshot quality too low for review (engine)
- [ ] **#42** No structured logging/observability (API/infra)

---

**Total: 45 items** — 4 P0, 15 P1, 18 P2, 8 P3
