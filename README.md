# Kery

Open-source AI-powered browser testing platform. Kery uses LLM agents to crawl your web app, generate test plans, execute them in a real browser, and find visual, functional, and UX bugs automatically.

## Features

- **AI Browser Agent** — LLM-driven Playwright automation that understands your app via accessibility tree + screenshots
- **Multi-Agent Architecture** — Navigator (executes), Review Agent (screenshots), Path Generator (plans), Network Monitor (API errors)
- **App Discovery** — BFS crawl discovers all pages, forms, modals, and interactions
- **Regression Engine** — Compiles successful runs into deterministic Playwright scripts, replays with zero LLM calls
- **Self-Healing** — When selectors break, Stagehand finds elements by intent
- **Agent Memory** — Learns from past runs to improve future testing

## Quick Start

### Docker (recommended)

```bash
# Clone and configure
cp .env.example .env
# Edit .env — add at least one LLM key (OPENROUTER_API_KEY or OPENAI_API_KEY)

# Start everything
docker compose up -d

# API is now at http://localhost:8080
```

### Local Development

```bash
# Prerequisites: Node 20+, PostgreSQL 16+

# Install dependencies
npm install

# Start Postgres (or use docker compose up postgres -d)
# Run migrations
DATABASE_URL=postgresql://kery:kery@localhost:5432/kery npm run migrate

# Start the API
npm run dev:api
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://kery:kery@localhost:5432/kery` | PostgreSQL connection string |
| `OPENROUTER_API_KEY` | | OpenRouter API key (recommended — routes to all models) |
| `OPENAI_API_KEY` | | Direct OpenAI API key (fallback) |
| `GEMINI_AGENT_MODEL` | `openai/gpt-4o-mini` | Model for browser automation decisions |
| `GEMINI_SUMMARY_MODEL` | `gemini-2.5-flash-lite` | Model for run summaries |
| `REVIEW_AGENT_MODEL` | `anthropic/claude-sonnet-4.6` | Model for screenshot review |
| `STAGEHAND_ENABLED` | `true` | Enable Stagehand for smart element finding |
| `RUN_TIMEOUT_MINUTES` | `15` | Max wall-clock time per test run |

## Architecture

```
packages/engine/   — Core testing engine (agent, LLM, crawl, regression)
packages/db/       — PostgreSQL storage adapter
apps/api/          — Fastify HTTP server
apps/web/          — Web dashboard (coming soon)
```

The engine is decoupled from the database via the `StorageAdapter` interface. This makes it possible to swap PostgreSQL for any other backend.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create project |
| `POST` | `/api/projects/:id/environments` | Add environment |
| `POST` | `/api/projects/:id/run` | Trigger test run |
| `GET` | `/api/runs/:id/stream` | SSE stream of run progress |
| `GET` | `/api/runs/:id` | Get run result |
| `POST` | `/api/projects/:id/scan` | Crawl & discover pages |
| `GET` | `/api/projects/:id/pages` | List discovered pages |
| `GET` | `/api/projects/:id/bugs` | List bugs |
| `POST` | `/api/projects/:id/tests` | Create saved test |

## License

Apache 2.0 — see [LICENSE](LICENSE).
