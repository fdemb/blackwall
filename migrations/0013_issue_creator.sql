-- Who created the issue. OpenProject issues take their author through the people mapping.
-- NULL when the author maps to no member, or a workspace import's creator has no account here.
ALTER TABLE issues ADD COLUMN created_by uuid REFERENCES users(id);

-- Every command logs its actor, so earlier issues take the actor of their create_issue entry.
UPDATE issues i SET created_by=a.actor
FROM activity a
WHERE a.workspace_id=i.workspace_id AND a.entity_id=i.id AND a.action='create_issue'
  AND i.openproject IS NULL;

CREATE INDEX issues_created_by ON issues(workspace_id, created_by) WHERE created_by IS NOT NULL;

-- Incremental polls only revisit changed work packages. Rescan so earlier imports get authors,
-- fencing in-flight leases the same way a people mapping change does.
WITH restarted AS (
 UPDATE openproject_connections
 SET generation=generation+1,
     checkpoint='{"phase":"projects","page":1,"refresh_only":false}'::jsonb,
     next_run_at=clock_timestamp(),status='pending',last_error=''
 WHERE enabled AND NOT deleted
 RETURNING id
)
UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE queue='openproject' AND state='pending'
 AND payload->>'connection_id' IN (SELECT id::text FROM restarted);
