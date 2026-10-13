-- Sprints count up per team, in start order, like issue numbers count up per workspace.
ALTER TABLE sprints ADD COLUMN number bigint;

UPDATE sprints s
SET number = r.n,
    version = s.version + 1
FROM (SELECT id, row_number() OVER (PARTITION BY workspace_id, team_id ORDER BY starts_at, id) AS n FROM sprints) r
WHERE r.id = s.id;

ALTER TABLE sprints ALTER COLUMN number SET NOT NULL;
ALTER TABLE sprints ADD CONSTRAINT sprints_number_positive CHECK (number > 0);
ALTER TABLE sprints ADD CONSTRAINT sprints_team_number UNIQUE (workspace_id, team_id, number);
