-- Change log for clients that keep a local copy of workspace records.
-- Triggers append one row per changed client entity. `txid` is the writing transaction, so readers
-- can use their snapshot xmin as a cursor: every transaction still in flight has txid >= xmin.
CREATE TABLE changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id uuid NOT NULL,
    entity text NOT NULL,
    entity_id uuid NOT NULL,
    -- Set for records only one member can see, such as notifications and private views.
    user_id uuid,
    txid bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX changes_feed ON changes(workspace_id, txid);
CREATE INDEX changes_created ON changes(created_at, id);

-- Cursors below this txid may point at pruned rows, so their clients must reload.
CREATE TABLE change_horizon (
    singleton bool PRIMARY KEY DEFAULT true CHECK (singleton),
    txid bigint NOT NULL
);
INSERT INTO change_horizon(txid) VALUES (0);

CREATE FUNCTION mark_change(p_workspace uuid, p_entity text, p_id uuid, p_user uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO changes(workspace_id, entity, entity_id, user_id)
    SELECT p_workspace, p_entity, p_id, p_user
    WHERE p_workspace IS NOT NULL AND p_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM changes c
        WHERE c.workspace_id = p_workspace AND c.txid = pg_current_xact_id()::text::bigint
          AND c.entity = p_entity AND c.entity_id = p_id
    );
$$;

-- Issues report subtask and blocker counts, so changes to one issue can change others.
CREATE FUNCTION mark_issue_neighbors(ws uuid, issue uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM mark_change(ws, 'issues', i.parent_id) FROM issues i WHERE i.id = issue;
    PERFORM mark_change(ws, 'issues', d.issue_id) FROM issue_dependencies d WHERE d.dependency_id = issue;
END;
$$;

CREATE FUNCTION record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    j jsonb;
    ws uuid;
    structural bool;
BEGIN
    FOREACH j IN ARRAY array_remove(ARRAY[new_row, old_row], NULL) LOOP
        ws := (j->>'workspace_id')::uuid;
        CASE TG_TABLE_NAME
            WHEN 'workspaces' THEN
                PERFORM mark_change((j->>'id')::uuid, 'workspace', (j->>'id')::uuid);
            WHEN 'workspace_members' THEN
                PERFORM mark_change(ws, 'members', (j->>'user_id')::uuid);
            WHEN 'teams' THEN
                PERFORM mark_change(ws, 'teams', (j->>'id')::uuid);
            WHEN 'team_members' THEN
                PERFORM mark_change(ws, 'teams', (j->>'team_id')::uuid);
                PERFORM mark_change(ws, 'members', (j->>'user_id')::uuid);
            WHEN 'stages' THEN
                PERFORM mark_change(ws, 'teams', (j->>'team_id')::uuid);
            WHEN 'project_teams' THEN
                PERFORM mark_change(ws, 'projects', (j->>'project_id')::uuid);
            WHEN 'sprint_outcomes' THEN
                PERFORM mark_change(ws, 'sprints', (j->>'sprint_id')::uuid);
            WHEN 'saved_views' THEN
                -- A view that was and stays private only concerns its owner.
                PERFORM mark_change(ws, 'views', (j->>'id')::uuid,
                    CASE WHEN NOT COALESCE((new_row->>'shared')::bool, false)
                          AND NOT COALESCE((old_row->>'shared')::bool, false)
                         THEN (j->>'owner')::uuid END);
            WHEN 'alert_preferences' THEN
                PERFORM mark_change(ws, 'alert_preferences', (j->>'user_id')::uuid, (j->>'user_id')::uuid);
            WHEN 'notifications' THEN
                PERFORM mark_change(ws, 'notifications', (j->>'id')::uuid, (j->>'user_id')::uuid);
            WHEN 'issues' THEN
                PERFORM mark_change(ws, 'issues', (j->>'id')::uuid);
                structural := TG_OP <> 'UPDATE'
                    OR new_row->'parent_id' IS DISTINCT FROM old_row->'parent_id'
                    OR new_row->'stage_id' IS DISTINCT FROM old_row->'stage_id'
                    OR new_row->'deleted_at' IS DISTINCT FROM old_row->'deleted_at';
                IF structural THEN
                    PERFORM mark_change(ws, 'issues', (j->>'parent_id')::uuid);
                    PERFORM mark_change(ws, 'issues', d.issue_id)
                    FROM issue_dependencies d WHERE d.dependency_id = (j->>'id')::uuid;
                END IF;
            WHEN 'issue_labels', 'issue_followers', 'issue_dependencies', 'source_links' THEN
                PERFORM mark_change(ws, 'issues', (j->>'issue_id')::uuid);
            WHEN 'comment_mentions' THEN
                PERFORM mark_change(ws, 'comments', (j->>'comment_id')::uuid);
            WHEN 'attachments' THEN
                IF j->>'comment_id' IS NULL THEN
                    PERFORM mark_change(ws, 'issues', (j->>'issue_id')::uuid);
                ELSE
                    PERFORM mark_change(ws, 'comments', (j->>'comment_id')::uuid);
                END IF;
            ELSE
                -- Tables whose client entity shares their name and id.
                PERFORM mark_change(ws, TG_ARGV[0], (j->>'id')::uuid);
        END CASE;
    END LOOP;

    -- A stage turning done or open changes subtask and blocker counts of related issues.
    IF TG_TABLE_NAME = 'stages' AND TG_OP = 'UPDATE'
        AND new_row->>'kind' IS DISTINCT FROM old_row->>'kind' THEN
        PERFORM mark_issue_neighbors((new_row->>'workspace_id')::uuid, i.id)
        FROM issues i WHERE i.stage_id = (new_row->>'id')::uuid;
    END IF;

    RETURN NULL;
END;
$$;

CREATE FUNCTION record_user_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM mark_change(m.workspace_id, 'members', NEW.id)
    FROM workspace_members m WHERE m.user_id = NEW.id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER record_change AFTER UPDATE ON workspaces FOR EACH ROW
    WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.version IS DISTINCT FROM NEW.version)
    EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER UPDATE OF email, profile ON users FOR EACH ROW
    EXECUTE FUNCTION record_user_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON teams FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON stages FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON labels FOR EACH ROW EXECUTE FUNCTION record_change('labels');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION record_change('projects');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON project_teams FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON milestones FOR EACH ROW EXECUTE FUNCTION record_change('milestones');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON sprints FOR EACH ROW EXECUTE FUNCTION record_change('sprints');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON sprint_outcomes FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON issues FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON issue_labels FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON issue_dependencies FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON issue_followers FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON source_links FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON comments FOR EACH ROW EXECUTE FUNCTION record_change('comments');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON comment_mentions FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON time_entries FOR EACH ROW EXECUTE FUNCTION record_change('time_entries');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON invitations FOR EACH ROW EXECUTE FUNCTION record_change('invitations');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON saved_views FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON alert_preferences FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change AFTER INSERT ON activity FOR EACH ROW EXECUTE FUNCTION record_change('activity');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON integrations FOR EACH ROW EXECUTE FUNCTION record_change('integrations');
