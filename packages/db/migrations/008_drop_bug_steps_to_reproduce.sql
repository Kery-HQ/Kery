-- Remove unused steps_to_reproduce column (garbage / redundant with trace)
ALTER TABLE bugs DROP COLUMN IF EXISTS steps_to_reproduce;
