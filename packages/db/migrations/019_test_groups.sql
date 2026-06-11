CREATE TABLE test_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  is_auto_scan BOOLEAN    NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One default group and one auto-scan group per project
CREATE UNIQUE INDEX test_groups_project_default   ON test_groups(project_id) WHERE is_default = true;
CREATE UNIQUE INDEX test_groups_project_auto_scan ON test_groups(project_id) WHERE is_auto_scan = true;

-- Add group FK to saved_tests (nullable — NULL treated as default group during migration window)
ALTER TABLE saved_tests ADD COLUMN group_id UUID REFERENCES test_groups(id) ON DELETE SET NULL;

-- Create default groups for every existing project and assign their tests
WITH inserted AS (
  INSERT INTO test_groups (project_id, name, is_default)
  SELECT id, 'Default', true FROM projects
  RETURNING id, project_id
)
UPDATE saved_tests st
SET group_id = inserted.id
FROM inserted
WHERE inserted.project_id = st.project_id;
