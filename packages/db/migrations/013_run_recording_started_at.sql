-- Add recording_started_at to track when Playwright started video recording.
-- Used by the frontend to sync video playback time with step timestamps.
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS recording_started_at BIGINT;
