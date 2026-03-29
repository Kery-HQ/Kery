-- LLM screenshots / full payloads are always-on; align DB default and existing rows.
ALTER TABLE saved_tests ALTER COLUMN save_screenshots SET DEFAULT true;
UPDATE saved_tests SET save_screenshots = true WHERE save_screenshots = false;
