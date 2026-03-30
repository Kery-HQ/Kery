-- Per–crawl-run LLM cost breakdown (link filtering vs suggested flows). Total remains in cost_usd.
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS llm_cost_breakdown_json jsonb;
