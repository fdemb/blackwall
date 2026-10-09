CREATE OR REPLACE FUNCTION record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    j jsonb;
    ws uuid;
BEGIN
    FOREACH j IN ARRAY array_remove(ARRAY[new_row, old_row], NULL) LOOP
        ws := (j->>'workspace_id')::uuid;
        CASE TG_TABLE_NAME
            WHEN 'workspaces' THEN
                PERFORM mark_change((j->>'id')::uuid, 'workspace', (j->>'id')::uuid);
            WHEN 'workspace_members' THEN
                PERFORM mark_change(ws, 'members', (j->>'user_id')::uuid);
                IF TG_OP = 'INSERT' OR TG_OP = 'DELETE'
                    OR new_row->>'role' IS DISTINCT FROM old_row->>'role' THEN
                    PERFORM mark_change(ws, 'roles', (j->>'user_id')::uuid, (j->>'user_id')::uuid);
                END IF;
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

    RETURN NULL;
END;
$$;

DROP FUNCTION mark_issue_neighbors(uuid, uuid);
