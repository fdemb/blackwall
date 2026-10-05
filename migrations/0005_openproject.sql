ALTER TABLE jobs DROP CONSTRAINT jobs_queue_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_queue_check CHECK(queue IN ('email','webhook','database','openproject'));
CREATE UNIQUE INDEX jobs_openproject_active ON jobs((payload->>'connection_id')) WHERE queue='openproject' AND state IN ('pending','running');
CREATE TABLE openproject_connections(
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
 name text NOT NULL, base_url text NOT NULL, token text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false,
 generation bigint NOT NULL DEFAULT 1, projects jsonb NOT NULL DEFAULT '[]',
 cached_projects jsonb NOT NULL DEFAULT '[]', cached_statuses jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending', last_error text NOT NULL DEFAULT '',
 last_checked_at timestamptz, last_synced_at timestamptz,
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 checkpoint jsonb NOT NULL DEFAULT '{"phase":"projects","page":1,"project_index":0,"refresh_only":false}'
);
CREATE INDEX openproject_due ON openproject_connections(next_run_at) WHERE enabled AND NOT deleted;
ALTER TABLE issues ADD COLUMN openproject jsonb;
CREATE UNIQUE INDEX issues_openproject_identity ON issues((openproject->>'connection_id'),(openproject->>'work_package_id')) WHERE openproject IS NOT NULL;
-- Position is local presentation state. Store dispatch still rejects direct moves of imports,
-- but neighboring local-card moves may rebalance every position in the destination stage.
CREATE FUNCTION protect_openproject_issue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.openproject IS NOT NULL AND current_setting('blackwall.openproject_sync',true) IS DISTINCT FROM 'on' AND
 (NEW.title,NEW.description,NEW.team_id,NEW.stage_id,NEW.assignee,NEW.priority,NEW.estimate,NEW.deadline,NEW.project_id,NEW.milestone_id,NEW.sprint_id,NEW.parent_id,NEW.deleted_at,NEW.openproject) IS DISTINCT FROM
 (OLD.title,OLD.description,OLD.team_id,OLD.stage_id,OLD.assignee,OLD.priority,OLD.estimate,OLD.deadline,OLD.project_id,OLD.milestone_id,OLD.sprint_id,OLD.parent_id,OLD.deleted_at,OLD.openproject) THEN
 RAISE EXCEPTION 'OpenProject imported issues are read-only' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_openproject_issue BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION protect_openproject_issue();
