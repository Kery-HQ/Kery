-- Kery OSS: combined schema (single-user, no org tables)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  domain                text,
  crawl_environment_id  uuid,
  auto_crawl_weekly     boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─── Environments ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS environments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  base_url    text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  allow_crawl boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD CONSTRAINT fk_crawl_env FOREIGN KEY (crawl_environment_id) REFERENCES environments(id) ON DELETE SET NULL;

-- ─── Auth Configs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  mode            text NOT NULL,
  config_json     jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment_id)
);

-- ─── Saved Tests ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS saved_tests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              text NOT NULL,
  intent            text NOT NULL,
  context           text,
  save_screenshots  boolean NOT NULL DEFAULT false,
  max_steps         int,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  discovery_source  text NOT NULL DEFAULT 'manual' CHECK (discovery_source IN ('manual', 'crawl')),
  crawl_node_id     uuid,
  regression_plan   jsonb,
  plan_success_count integer NOT NULL DEFAULT 0,
  plan_status       text NOT NULL DEFAULT 'none',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ─── Test Runs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_id         text,
  environment_id  uuid REFERENCES environments(id),
  test_id         uuid REFERENCES saved_tests(id),
  destination_id  uuid,
  trigger_type    text NOT NULL DEFAULT 'manual',
  trigger_ref     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'partial')),
  summary         text,
  steps_json      jsonb,
  memory_loaded   jsonb,
  bugs_json       jsonb,
  llm_calls_json  jsonb,
  video_url       text,
  source_type     text,
  source_label    text,
  source_back_path text,
  started_at      timestamptz,
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS test_runs_project_idx ON test_runs(project_id);
CREATE INDEX IF NOT EXISTS test_runs_status_idx ON test_runs(status);

-- ─── Bugs ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bugs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  environment_id    uuid REFERENCES environments(id) ON DELETE SET NULL,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  category          text NOT NULL CHECK (category IN ('visual', 'functional', 'ux', 'other')),
  severity          text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
  steps_to_reproduce jsonb NOT NULL DEFAULT '[]',
  url               text,
  run_label         text,
  reported_at       timestamptz NOT NULL,
  environment       text,
  step_index        int,
  screenshot_base64 text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bugs_project_status_idx ON bugs(project_id, status);
CREATE INDEX IF NOT EXISTS bugs_run_id_idx ON bugs(run_id);

-- ─── Crawl Runs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crawl_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id    uuid NOT NULL REFERENCES environments(id),
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  trigger_type      text NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'scheduled')),
  pages_visited     int,
  nodes_found       int,
  destinations_built int,
  sitemap_json      jsonb,
  cost_usd          numeric(10,6),
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS crawl_runs_project_idx ON crawl_runs(project_id);

-- ─── Crawl Nodes ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crawl_nodes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  normalized_route       text NOT NULL,
  interaction_label      text,
  node_key               text NOT NULL,
  enabled                boolean NOT NULL DEFAULT false,
  is_recommended         boolean NOT NULL DEFAULT false,
  last_seen_crawl_run_id uuid REFERENCES crawl_runs(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, node_key)
);

-- ─── App Tree Destinations ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_tree_destinations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  normalized_route   text NOT NULL,
  title              text NOT NULL DEFAULT '',
  forms_json         jsonb NOT NULL DEFAULT '[]',
  buttons_json       jsonb NOT NULL DEFAULT '[]',
  interactions_json  jsonb NOT NULL DEFAULT '[]',
  nav_links          jsonb NOT NULL DEFAULT '[]',
  health_status      text NOT NULL DEFAULT 'untested' CHECK (health_status IN ('clean', 'issues', 'stale', 'untested')),
  issues_count       int NOT NULL DEFAULT 0,
  last_inspected_at  timestamptz,
  last_crawled_at    timestamptz NOT NULL DEFAULT now(),
  crawl_run_id       uuid REFERENCES crawl_runs(id),
  enabled            boolean NOT NULL DEFAULT true,
  regression_plan    jsonb,
  plan_success_count integer NOT NULL DEFAULT 0,
  plan_status        text NOT NULL DEFAULT 'none',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized_route)
);

CREATE INDEX IF NOT EXISTS app_tree_dest_project_idx ON app_tree_destinations(project_id);

-- ─── App Tree Flow Edges ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_tree_flow_edges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_destination_id  uuid NOT NULL REFERENCES app_tree_destinations(id) ON DELETE CASCADE,
  target_destination_id  uuid NOT NULL REFERENCES app_tree_destinations(id) ON DELETE CASCADE,
  trigger_action         text NOT NULL DEFAULT 'navigate',
  trigger_label          text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_destination_id, target_destination_id, trigger_label)
);

-- ─── Run Coverage ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS run_coverage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  destination_id  uuid NOT NULL REFERENCES app_tree_destinations(id) ON DELETE CASCADE,
  inspected_at    timestamptz NOT NULL DEFAULT now(),
  bugs_found      int NOT NULL DEFAULT 0,
  UNIQUE (run_id, destination_id)
);

-- ─── Memory Entries ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL CHECK (scope IN ('project', 'page')),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES app_tree_destinations(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('learned_path', 'ignore_region', 'avoid_region', 'bug_pattern', 'tip')),
  summary         text NOT NULL,
  content         text NOT NULL,
  region          jsonb,
  source          text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'user')),
  confidence      int NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_scope_check CHECK (
    (scope = 'project' AND project_id IS NOT NULL) OR
    (scope = 'page'    AND destination_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS memory_entries_project_idx ON memory_entries(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entries_destination_idx ON memory_entries(destination_id) WHERE destination_id IS NOT NULL;

-- Add destination_id FK to test_runs after app_tree_destinations exists
ALTER TABLE test_runs ADD CONSTRAINT fk_test_runs_dest FOREIGN KEY (destination_id) REFERENCES app_tree_destinations(id) ON DELETE SET NULL;
-- Add crawl_node_id FK to saved_tests after crawl_nodes exists
ALTER TABLE saved_tests ADD CONSTRAINT fk_saved_tests_crawl_node FOREIGN KEY (crawl_node_id) REFERENCES crawl_nodes(id) ON DELETE SET NULL;
