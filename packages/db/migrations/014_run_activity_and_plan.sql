ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS activity_json jsonb,
  ADD COLUMN IF NOT EXISTS agent_plan_json jsonb;
