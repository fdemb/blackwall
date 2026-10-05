CREATE OR REPLACE FUNCTION protect_openproject_issue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE migration jsonb;
BEGIN
 IF OLD.openproject IS NULL OR current_setting('blackwall.openproject_sync',true) = 'on' THEN
  RETURN NEW;
 END IF;
 IF (NEW.title,NEW.description,NEW.team_id,NEW.stage_id,NEW.assignee,NEW.priority,NEW.estimate,NEW.deadline,NEW.project_id,NEW.milestone_id,NEW.sprint_id,NEW.parent_id,NEW.deleted_at,NEW.openproject) IS NOT DISTINCT FROM
 (OLD.title,OLD.description,OLD.team_id,OLD.stage_id,OLD.assignee,OLD.priority,OLD.estimate,OLD.deadline,OLD.project_id,OLD.milestone_id,OLD.sprint_id,OLD.parent_id,OLD.deleted_at,OLD.openproject) THEN
  RETURN NEW;
 END IF;
 migration := NULLIF(current_setting('blackwall.stage_migration',true),'')::jsonb;
 IF migration->>'workspace_id' = OLD.workspace_id::text
 AND migration->>'from' = OLD.stage_id::text AND migration->>'to' = NEW.stage_id::text
 AND (NEW.title,NEW.description,NEW.team_id,NEW.assignee,NEW.priority,NEW.estimate,NEW.deadline,NEW.project_id,NEW.milestone_id,NEW.sprint_id,NEW.parent_id,NEW.deleted_at,NEW.openproject) IS NOT DISTINCT FROM
 (OLD.title,OLD.description,OLD.team_id,OLD.assignee,OLD.priority,OLD.estimate,OLD.deadline,OLD.project_id,OLD.milestone_id,OLD.sprint_id,OLD.parent_id,OLD.deleted_at,OLD.openproject) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'OpenProject imported issues are read-only'
  USING ERRCODE='23514', CONSTRAINT='blackwall_issue_ownership';
END;
$$;

CREATE FUNCTION protect_openproject_local_record() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF current_setting('blackwall.openproject_sync',true) IS DISTINCT FROM 'on'
 AND EXISTS(SELECT 1 FROM issues WHERE openproject IS NOT NULL
   AND ((workspace_id=workspace AND id=issue)
     OR (workspace_id=previous_workspace AND id=previous_issue))) THEN
  RAISE EXCEPTION 'OpenProject imported issues are read-only'
   USING ERRCODE='23514', CONSTRAINT='blackwall_issue_ownership';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER protect_openproject_source_link BEFORE INSERT OR UPDATE OR DELETE ON source_links
 FOR EACH ROW EXECUTE FUNCTION protect_openproject_local_record();
CREATE TRIGGER protect_openproject_attachment_removal BEFORE DELETE ON attachments
 FOR EACH ROW WHEN (OLD.comment_id IS NULL) EXECUTE FUNCTION protect_openproject_local_record();
