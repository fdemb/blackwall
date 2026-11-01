-- Teams opt into sprints. Teams that have ever had a sprint keep them.
ALTER TABLE teams ADD COLUMN sprints boolean NOT NULL DEFAULT false;

UPDATE teams t
SET sprints = true, version = t.version + 1
WHERE EXISTS (SELECT 1 FROM sprints s WHERE s.workspace_id = t.workspace_id AND s.team_id = t.id);
