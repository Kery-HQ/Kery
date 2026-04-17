ALTER TABLE saved_tests ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
