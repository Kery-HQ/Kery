# @keryai/mcp

Model Context Protocol server for [Kery](https://github.com/Kery-HQ/Kery) — lets
AI agents in your IDE scan your app, run browser tests, and triage bugs without
leaving the editor.

---

## Which one do I need?

**Kery Cloud (hosted) — use the remote MCP server instead.** Nothing to
install, no API keys to paste, no Node or Docker required:

```bash
claude mcp add --transport http kery https://api.kery.dev/mcp
```

A browser opens, you press **Connect**, and your client receives its own scoped
token. For `mcp.json` clients (Cursor, Windsurf, and friends):

```json
{
  "mcpServers": {
    "kery": { "url": "https://api.kery.dev/mcp" }
  }
}
```

The hosted server exposes a superset of the tools below, and CI jobs that can't
run a browser flow can pass a static `Authorization: Bearer` header instead.
Details are in your workspace settings at [app.kery.dev](https://app.kery.dev).

**Self-hosted OSS — this package is the right path.** It speaks stdio to a Kery
instance you run yourself (`npx keryai` / Docker). Read on.

---

## Install

The setup wizard writes the config for you:

```bash
npx keryai   # select "Install MCP" during setup
```

Or add it to your MCP config by hand:

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

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kery]
command = "npx"
args = ["-y", "@keryai/mcp"]

[mcp_servers.kery.env]
KERY_API_URL = "http://localhost:11111"
KERY_WEB_URL = "http://localhost:11111"
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KERY_API_URL` | `http://localhost:11111` | Kery API base URL |
| `KERY_WEB_URL` | `http://localhost:11111` | Dashboard URL used in returned links |
| `KERY_API_KEY` | — | Bearer token. Legacy Cloud path — prefer the remote MCP server above |

Setting `KERY_API_KEY` switches the server into cloud mode, which hides the
Docker lifecycle tools (`kery_start`, `kery_stop`). This still works, but the
remote MCP server is the supported way to reach Kery Cloud: it authenticates
through OAuth, so no long-lived key sits in your MCP config, and it tracks the
Cloud API without a package upgrade.

## Tools

| Area | Tools |
|---|---|
| Lifecycle | `kery_start`, `kery_stop`, `kery_status`, `kery_test_connection` |
| Projects | `kery_setup_project`, `kery_list_projects`, `kery_update_project` |
| Environments | `kery_add_environment`, `kery_update_environment`, `kery_update_auth` |
| Discovery | `kery_scan`, `kery_discover_flows`, `kery_list_routes`, `kery_update_page` |
| Tests | `kery_list_tests`, `kery_update_test`, `kery_delete_test` |
| Runs | `kery_run_test`, `kery_list_runs`, `kery_get_run`, `kery_stop_run` |
| Bugs | `kery_get_bugs`, `kery_update_bug` |
| Coverage | `kery_get_coverage` |
| Memory | `kery_memory` |
| Settings | `kery_get_settings`, `kery_update_settings` |

## License

Apache-2.0
