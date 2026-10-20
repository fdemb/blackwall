-- Provider-neutral issue trackers. OpenProject becomes the first provider, and remote IDs become strings.
ALTER TABLE openproject_connections RENAME TO tracker_connections;
ALTER TABLE tracker_connections RENAME CONSTRAINT openproject_connections_pkey TO tracker_connections_pkey;
ALTER TABLE tracker_connections RENAME CONSTRAINT openproject_connections_workspace_id_fkey TO tracker_connections_workspace_id_fkey;
ALTER INDEX openproject_due RENAME TO tracker_due;
ALTER TABLE tracker_connections ADD COLUMN provider text NOT NULL DEFAULT 'openproject';
ALTER TABLE tracker_connections ALTER COLUMN provider DROP DEFAULT;
-- Existing connections keep importing every field and send nothing until an admin opts in.
ALTER TABLE tracker_connections ADD COLUMN options jsonb NOT NULL DEFAULT '{}';
UPDATE tracker_connections SET options=(
 SELECT jsonb_object_agg(field,'{"import":true,"export":false}'::jsonb)
 FROM unnest(ARRAY['status','title','description','assignee','due_date','priority','parent','comments']) AS field);
ALTER TABLE tracker_connections ALTER COLUMN options DROP DEFAULT;

CREATE FUNCTION pg_temp.string_ids(items jsonb, key text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT COALESCE(jsonb_agg(CASE WHEN item ? key THEN item || jsonb_build_object(key,item->>key) ELSE item END ORDER BY ordinality),'[]'::jsonb)
 FROM jsonb_array_elements(items) WITH ORDINALITY AS element(item,ordinality)
$$;
UPDATE tracker_connections SET
 projects=pg_temp.string_ids(projects,'project_id'),
 cached_projects=pg_temp.string_ids(cached_projects,'id'),
 cached_statuses=pg_temp.string_ids(cached_statuses,'id'),
 cached_people=pg_temp.string_ids(cached_people,'id');

ALTER TABLE openproject_discovery_pages RENAME TO tracker_discovery_pages;
ALTER TABLE tracker_discovery_pages RENAME CONSTRAINT openproject_discovery_pages_pkey TO tracker_discovery_pages_pkey;
ALTER TABLE tracker_discovery_pages RENAME CONSTRAINT openproject_discovery_pages_connection_id_fkey TO tracker_discovery_pages_connection_id_fkey;
ALTER TABLE tracker_discovery_pages DROP CONSTRAINT openproject_discovery_pages_resource_check;
UPDATE tracker_discovery_pages SET resource='people' WHERE resource='users';
UPDATE tracker_discovery_pages SET items=pg_temp.string_ids(items,'id');
ALTER TABLE tracker_discovery_pages ADD CONSTRAINT tracker_discovery_pages_resource_check CHECK(resource IN ('projects','statuses','people'));

ALTER TABLE jobs DROP CONSTRAINT jobs_queue_check;
UPDATE jobs SET queue='tracker' WHERE queue='openproject';
UPDATE jobs SET kind='tracker' WHERE kind='openproject';
ALTER TABLE jobs ADD CONSTRAINT jobs_queue_check CHECK(queue IN ('email','webhook','database','tracker'));
DROP INDEX jobs_openproject_active;
CREATE UNIQUE INDEX jobs_tracker_active ON jobs((payload->>'connection_id')) WHERE queue='tracker' AND state IN ('pending','running');

DROP INDEX issues_openproject_identity;
DROP INDEX issues_openproject_parent;
ALTER TABLE issues RENAME COLUMN openproject TO tracker;

-- The ownership triggers move to the renamed column until synced issues become editable.
CREATE OR REPLACE FUNCTION protect_openproject_issue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE migration jsonb;
BEGIN
 IF OLD.tracker IS NULL OR current_setting('blackwall.tracker',true) = 'on' THEN
  RETURN NEW;
 END IF;
 IF (NEW.title,NEW.description,NEW.team_id,NEW.stage_id,NEW.assignee,NEW.priority,NEW.estimate,NEW.deadline,NEW.project_id,NEW.milestone_id,NEW.sprint_id,NEW.parent_id,NEW.deleted_at,NEW.tracker) IS NOT DISTINCT FROM
 (OLD.title,OLD.description,OLD.team_id,OLD.stage_id,OLD.assignee,OLD.priority,OLD.estimate,OLD.deadline,OLD.project_id,OLD.milestone_id,OLD.sprint_id,OLD.parent_id,OLD.deleted_at,OLD.tracker) THEN
  RETURN NEW;
 END IF;
 migration := NULLIF(current_setting('blackwall.stage_migration',true),'')::jsonb;
 IF migration->>'workspace_id' = OLD.workspace_id::text
 AND migration->>'from' = OLD.stage_id::text AND migration->>'to' = NEW.stage_id::text
 AND (NEW.title,NEW.description,NEW.team_id,NEW.assignee,NEW.priority,NEW.estimate,NEW.deadline,NEW.project_id,NEW.milestone_id,NEW.sprint_id,NEW.parent_id,NEW.deleted_at,NEW.tracker) IS NOT DISTINCT FROM
 (OLD.title,OLD.description,OLD.team_id,OLD.assignee,OLD.priority,OLD.estimate,OLD.deadline,OLD.project_id,OLD.milestone_id,OLD.sprint_id,OLD.parent_id,OLD.deleted_at,OLD.tracker) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Tracked issues are read-only'
  USING ERRCODE='23514', CONSTRAINT='blackwall_issue_ownership';
END;
$$;

CREATE OR REPLACE FUNCTION protect_openproject_local_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issue uuid; workspace uuid; previous_issue uuid; previous_workspace uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN
  issue := OLD.issue_id; workspace := OLD.workspace_id;
 ELSE
  issue := NEW.issue_id; workspace := NEW.workspace_id;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  previous_issue := OLD.issue_id; previous_workspace := OLD.workspace_id;
 END IF;
 IF current_setting('blackwall.tracker',true) IS DISTINCT FROM 'on'
 AND EXISTS(SELECT 1 FROM issues WHERE tracker IS NOT NULL
   AND ((workspace_id=workspace AND id=issue)
     OR (workspace_id=previous_workspace AND id=previous_issue))) THEN
  RAISE EXCEPTION 'Tracked issues are read-only'
   USING ERRCODE='23514', CONSTRAINT='blackwall_issue_ownership';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

SELECT set_config('blackwall.tracker','on',true);
UPDATE issues SET tracker=jsonb_strip_nulls(jsonb_build_object(
 'provider','openproject',
 'connection_id',tracker->'connection_id',
 'remote_id',tracker->>'work_package_id',
 'project_id',tracker->>'project_id',
 'parent_remote_id',tracker->>'parent_work_package_id',
 'status_name',tracker->'status_name',
 'url',tracker->'url'))
WHERE tracker IS NOT NULL;
SELECT set_config('blackwall.tracker','',true);

CREATE UNIQUE INDEX issues_tracker_identity ON issues((tracker->>'connection_id'),(tracker->>'remote_id')) WHERE tracker IS NOT NULL;
-- Page transactions link already-imported children of arriving remote issues.
CREATE INDEX issues_tracker_parent ON issues(workspace_id,(tracker->>'connection_id'),(tracker->>'parent_remote_id')) WHERE tracker IS NOT NULL;
DROP FUNCTION pg_temp.string_ids(jsonb,text);
