-- Convert stale routes to untested and drop the crawl_miss_streak tracking column.
-- Routes that disappeared from crawl scans were being marked 'stale' after 3 consecutive
-- misses but this state adds complexity without actionable value — reset to 'untested'.

UPDATE app_tree_destinations SET health_status = 'untested' WHERE health_status = 'stale';

ALTER TABLE app_tree_destinations DROP COLUMN IF EXISTS crawl_miss_streak;

ALTER TABLE app_tree_destinations
  DROP CONSTRAINT IF EXISTS app_tree_destinations_health_status_check;

ALTER TABLE app_tree_destinations
  ADD CONSTRAINT app_tree_destinations_health_status_check
  CHECK (health_status IN ('untested', 'clean', 'issues'));
