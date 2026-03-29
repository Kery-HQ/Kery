-- Persist aggregate LLM spend per test run (sum of llm_calls_json costs).
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS cost_usd numeric(10,6);
