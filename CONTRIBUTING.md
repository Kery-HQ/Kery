# Contributing to Kery

Thank you for your interest in contributing to Kery!

## Development Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your LLM API keys
3. Start PostgreSQL: `docker compose up postgres -d`
4. Run migrations: `DATABASE_URL=postgresql://kery:kery@localhost:19832/kery npm run migrate`
5. Start the API: `npm run dev:api`

## Architecture

Kery is a monorepo with three packages:

- **packages/engine** — Core testing engine (agent, LLM, crawl, regression). Pure TypeScript, no database imports.
- **packages/db** — PostgreSQL adapter implementing the `StorageAdapter` interface from the engine.
- **apps/api** — Fastify HTTP server wiring everything together.

### Key Pattern: StorageAdapter

Engine services never import database code directly. Instead, they accept a `StorageAdapter` parameter. This makes the engine portable across different backends.

## Pull Requests

- One feature per PR
- Include tests for new functionality
- Follow existing code style
- Update types when changing interfaces

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
