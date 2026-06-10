ALTER TABLE saved_tests ADD COLUMN IF NOT EXISTS discovery_source text NOT NULL DEFAULT 'manual';
ALTER TABLE saved_tests ADD COLUMN IF NOT EXISTS discovery_run_id uuid REFERENCES test_runs(id) ON DELETE SET NULL;
