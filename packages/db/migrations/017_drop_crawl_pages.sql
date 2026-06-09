-- Remove all crawl / pages / scans infrastructure. Flows only from here on.

DROP TABLE IF EXISTS app_tree_flow_edges CASCADE;
DROP TABLE IF EXISTS run_coverage CASCADE;
DROP TABLE IF EXISTS app_tree_destinations CASCADE;
DROP TABLE IF EXISTS crawl_nodes CASCADE;
DROP TABLE IF EXISTS crawl_runs CASCADE;

ALTER TABLE projects DROP COLUMN IF EXISTS crawl_environment_id;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS fk_crawl_env;
ALTER TABLE projects DROP COLUMN IF EXISTS auto_crawl_weekly;

ALTER TABLE environments DROP COLUMN IF EXISTS allow_crawl;

ALTER TABLE saved_tests DROP CONSTRAINT IF EXISTS fk_saved_tests_crawl_node;
ALTER TABLE saved_tests DROP COLUMN IF EXISTS discovery_source;
ALTER TABLE saved_tests DROP COLUMN IF EXISTS crawl_node_id;

ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS fk_test_runs_dest;
ALTER TABLE test_runs DROP COLUMN IF EXISTS destination_id;

-- Simplify memory to project scope only (page-scoped entries depended on destinations)
DELETE FROM memory_entries WHERE scope = 'page';
ALTER TABLE memory_entries DROP COLUMN IF EXISTS destination_id;
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_scope_check;
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_scope_check;
ALTER TABLE memory_entries ADD CONSTRAINT memory_scope_check CHECK (project_id IS NOT NULL);
ALTER TABLE memory_entries ALTER COLUMN scope SET DEFAULT 'project';
