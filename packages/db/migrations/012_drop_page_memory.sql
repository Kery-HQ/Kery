-- Remove page-scoped memory entries and tighten the memory_entries schema.
-- All memory is now project-scoped only.

-- 1. Delete all page-scoped rows
DELETE FROM memory_entries WHERE scope = 'page';

-- 2. Drop the destination_id column (no longer needed)
ALTER TABLE memory_entries DROP COLUMN IF EXISTS destination_id;

-- 3. Tighten the scope check to only allow 'project'
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_scope_check;
ALTER TABLE memory_entries ADD CONSTRAINT memory_scope_check
  CHECK (scope = 'project' AND project_id IS NOT NULL);

-- 4. Drop the destination index (no longer useful)
DROP INDEX IF EXISTS memory_entries_destination_idx;
