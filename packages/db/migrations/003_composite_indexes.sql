-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_test_runs_project_status ON test_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_run_coverage_dest_inspected ON run_coverage(destination_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_bugs_project_reported ON bugs(project_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_entries_project_confidence ON memory_entries(project_id, confidence DESC);
