-- Optional bounding box for bugs (review/filmstrip); 0–1000 normalized or pixel coords.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS region jsonb NULL;
