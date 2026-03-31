-- Drop partial run status: runs are passed or failed only.
UPDATE test_runs SET status = 'passed' WHERE status = 'partial';

ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_status_check;
ALTER TABLE test_runs ADD CONSTRAINT test_runs_status_check
  CHECK (status IN ('queued', 'running', 'passed', 'failed'));
