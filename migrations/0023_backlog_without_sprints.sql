-- Backlog work has no sprint. Take existing backlog issues out of their sprints.
UPDATE issues i
SET sprint_id = NULL, version = i.version + 1, updated_at = now()
FROM stages s
WHERE s.workspace_id = i.workspace_id AND s.id = i.stage_id
  AND s.kind = 'backlog' AND i.sprint_id IS NOT NULL;
