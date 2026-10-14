-- Pull resets only when the actor's own role changes. Other membership
-- edits (profile updates, team joins) ride along as normal `members` rows.
-- The `roles` marker is a distinct entity so the per-transaction dedupe in
-- `mark_change` keeps it separate from the `members` row, and its `user_id`
-- keeps it private to that member.
CREATE OR REPLACE FUNCTION record_change() RETURNS trigger LANGUAGE plpgsql AS $$
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

-- Whole-window role checks must not scan unrelated change rows.
CREATE INDEX changes_roles ON changes(workspace_id, entity_id, txid) WHERE entity = 'roles';
