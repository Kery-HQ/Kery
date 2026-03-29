-- Bug screenshots: bytes live on disk (SCREENSHOTS_DIR/<run_id>/); DB keeps filename only.
ALTER TABLE bugs DROP COLUMN IF EXISTS screenshot_base64;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS screenshot_path text NULL;
