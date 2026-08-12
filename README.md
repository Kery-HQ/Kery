<p align="center">🚀 <strong>Kery Web is live:</strong> run Kery in the cloud at <a href="https://app.kery.dev"><strong>app.kery.dev</strong></a></p>

<p align="center">
  <img src="apps/web/public/logo/kery.png" width="80" alt="Kery" />
</p>

<h1 align="center">Kery</h1>

<p align="center">
  <strong>AI agents that test your web app and prove what works — with annotated screenshot evidence.</strong>
</p>

<p align="center">
  <a href="https://github.com/keryai/kery/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://www.npmjs.com/package/keryai"><img src="https://img.shields.io/npm/v/keryai.svg" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/MCP-compatible-8A2BE2" alt="MCP" />
  <a href="https://discord.gg/8npJXGWREM"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<br />

Point Kery at your web app, pick an LLM provider, and let it loose. It drives a real browser through your flows, grades every claim about the change — **verified** or **contradicted** — and backs each verdict with an annotated screenshot: the proving element boxed, the expected-vs-observed caption burned in. Bugs come with the same evidence. No selectors to write. No scripts to maintain, no "trust me" test output.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/evidence-verified.jpg" alt="Verified check — the estimate page renders with items and summary, boxed in green with the confirming evidence caption" />
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/evidence-contradicted.jpg" alt="Contradicted check — quantity drops below 1, zoomed and boxed in red with the expected-vs-found caption" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>✅ Verified</strong> — proof it works</td>
    <td align="center"><strong>❌ Contradicted</strong> — proof it doesn't</td>
  </tr>
</table>

<sub>Real output from a single run: Kery read the PR, generated these checks itself, drove the preview, and rendered the evidence.</sub>

<p align="center">
  <strong><a href="https://discord.gg/8npJXGWREM">👾 Join the Discord</a> — get help, share what you find, follow development.</strong>
</p>

---

## Quick Start

The fastest path: one command sets up everything.

```bash
npx keryai
```

The CLI wizard asks for your LLM provider and API key, generates a `docker-compose.yml`, and starts all services. Dashboard opens at `http://localhost:11111`.

**Manual Docker setup:**

```bash
cp .env.example .env
# Add at least one LLM key — see Configuration below
docker compose up -d
```

**Local development (no Docker):**

```bash
# Requires Node 20+, PostgreSQL 16+, Redis
npm install
DATABASE_URL=postgresql://kery:kery@localhost:11112/kery npm run migrate
npm run dev:api   # API + Dashboard → http://localhost:11111
```

---

## How It Works

**1. Scan** — Kery BFS-crawls your app and builds a map of every route, form, modal, and interaction.

**2. Plan** — For each route or saved test intent, a path-planning agent generates a sequence of steps to exercise that flow.

**3. Run** — A Navigator agent drives a real Playwright browser, observing the page via accessibility tree and screenshots. A Review Agent and Filmstrip Reviewer run in parallel, watching for visual and UX regressions.

**4. Verify** — A Verification Agent grades every claim against the recorded trace: **verified** needs an observed effect (navigator say-so doesn't count), **contradicted** needs the failure on screen. A vision pass localizes the proving element, and each verdict is rendered as evidence — zoomed crop, bounding box, expected-vs-observed caption.

**5. Report** — A Triage Agent deduplicates findings, filters false positives using memory from past runs, and outputs bugs categorized by type (visual / functional / UX) and severity — each with the same annotated-screenshot treatment.

---

## Features

**Verified Evidence**
- Every run grades its checks: verified / contradicted / not testable — with the reasoning
- Annotated screenshot per verdict: the proving element localized and boxed, caption bar with expected vs. observed
- Zoom crops keep small targets (a button, a price) legible; captures run at 2x scale for retina-sharp evidence
- Full-run video recording, scoped clips per finding

**App Discovery**
- BFS crawler maps all routes, links, forms, and modals
- Route health dashboard — clean / issues / stale / untested
- Depth and scope controls per project

**Autonomous Testing**
- Intent-driven tests: describe what to test in plain English
- Supports authenticated flows — form login, Clerk, Supabase, OAuth, API tokens
- Navigator agent uses accessibility tree + screenshots, not brittle CSS selectors
- Stagehand self-healing: when the DOM shifts, elements are found by intent

**Bug Detection**
- Visual bugs — layout breaks, rendering glitches, pixel regressions
- Functional bugs — broken flows, unexpected errors, failed assertions
- UX bugs — confusing copy, missing feedback, accessibility gaps
- Screenshot per bug with highlighted bounding box; URL, severity, and source agent

**Agent Memory**
- Learns successful navigation paths across runs
- Records known false positives, ignore regions, and bug patterns
- Confidence scoring with decay — memory stays fresh, not compounding

**Integrations**
- MCP server: run tests and triage bugs from Claude Code, Cursor, or any MCP-compatible IDE
- TypeScript client SDK for CI/CD and custom orchestration
- REST API + SSE streaming for real-time run progress

**LLM Flexibility**
- Anthropic (recommended default), OpenRouter, OpenAI, Google Gemini
- Each agent role (Navigator, Review, Auxiliary, Stagehand) configurable independently
- Per-run token and cost tracking

---

## MCP — Run Kery from Your IDE

Connect your editor and run tests without leaving it. Which server you want
depends on where Kery runs.

### Kery Cloud (hosted) — remote MCP

Nothing to install. One command, browser auth, no API keys to paste:

```bash
claude mcp add --transport http kery https://api.kery.dev/mcp
```

For `mcp.json` clients (Cursor, Windsurf, and friends):

```json
{
  "mcpServers": {
    "kery": { "url": "https://api.kery.dev/mcp" }
  }
}
```

Your client registers itself over OAuth and gets its own scoped token, which you
can revoke any time from Settings.

### Self-hosted OSS — stdio MCP

Running Kery yourself with Docker? Use the `@keryai/mcp` package. The setup
wizard writes the config for you:

```bash
npx keryai   # select "Install MCP" during setup
```

Or add it manually to your MCP config:

```json
{
  "mcpServers": {
    "kery": {
      "command": "npx",
      "args": ["-y", "@keryai/mcp"],
      "env": {
        "KERY_API_URL": "http://localhost:11111",
        "KERY_WEB_URL": "http://localhost:11111"
      }
    }
  }
}
```

Once connected, your AI assistant can scan your app, run tests, and triage bugs inline — no context switching.

**Available tools:** `kery_scan`, `kery_run_test`, `kery_get_bugs`, `kery_update_bug`, `kery_list_routes`, `kery_memory`, `kery_get_coverage`, and [20+ more](packages/mcp/README.md).

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://kery:kery@localhost:11112/kery` | PostgreSQL connection string |
| `OPENROUTER_API_KEY` | — | OpenRouter key (routes to all models — recommended) |
| `OPENAI_API_KEY` | — | Direct OpenAI key |
| `ANTHROPIC_API_KEY` | — | Direct Anthropic key |
| `GEMINI_API_KEY` | — | Direct Google Gemini key |
| `AGENT_MODEL` | `anthropic/claude-sonnet-5` | Model for browser navigation decisions |
| `AUXILIARY_MODEL` | `anthropic/claude-haiku-4.5` | Crawl, path planning, memory curation, summarization |
| `REVIEW_AGENT_MODEL` | `anthropic/claude-sonnet-5` | Post-run holistic and filmstrip screenshot analysis |
| `STAGEHAND_ENABLED` | `true` | Enable Stagehand for semantic element finding |
| `STAGEHAND_MODEL` | `anthropic/claude-haiku-4.5` | Model for Stagehand element finding |
| `RUN_TIMEOUT_MINUTES` | `15` | Max wall-clock time per test run |

All model settings are also configurable via the dashboard under **Settings**.

---

## Architecture

```
packages/
  engine/     — Core agent loop, LLM client, crawler, memory, bug triage
  db/         — PostgreSQL storage adapter (StorageAdapter interface)
  kery/       — CLI setup wizard (npx keryai)
  mcp/        — Model Context Protocol server (@keryai/mcp)
  client/     — TypeScript HTTP client SDK (@keryai/client)

apps/
  api/        — Fastify HTTP server
  web/        — React dashboard
  worker/     — Test run executor (BullMQ)
```

The engine is storage-agnostic via the `StorageAdapter` interface — PostgreSQL is the default, but other backends can be plugged in.

---

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss large changes before starting work.

```bash
git clone https://github.com/keryai/kery
cd kery
npm install
cp .env.example .env
docker compose up postgres redis -d
npm run dev
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
