-- Consecutive crawls where a route was not in the sitemap; at 3+, health is marked stale (outdated snapshot).
ALTER TABLE app_tree_destinations ADD COLUMN IF NOT EXISTS crawl_miss_streak int NOT NULL DEFAULT 0;
