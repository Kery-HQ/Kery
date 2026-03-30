-- Full LLM audit trail and crawl analysis metadata (limits, timing, stats).
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS llm_calls_json jsonb;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS crawl_metadata_json jsonb;
