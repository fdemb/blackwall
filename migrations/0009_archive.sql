-- Per-team auto-archive for Done issues. NULL means never archive.
ALTER TABLE teams ADD COLUMN archive_after_days integer DEFAULT 30
  CHECK (archive_after_days IS NULL OR archive_after_days BETWEEN 1 AND 3650);

ALTER TABLE issues ADD COLUMN archived_at timestamptz;
ALTER TABLE issues ADD COLUMN done_at timestamptz;

-- Sweep for auto-archiving Done issues past their team's deadline.
CREATE INDEX issues_archive_sweep ON issues(workspace_id, team_id, done_at, id)
  WHERE archived_at IS NULL AND deleted_at IS NULL AND done_at IS NOT NULL;
CREATE INDEX issues_archived ON issues(workspace_id, archived_at, id)
  WHERE archived_at IS NOT NULL;
