-- The NOT EXISTS probe had no covering index, so each insert scanned every row its transaction had
-- already written, which is quadratic for bulk writes. Pull dedupes by (entity, id) per page, so a
-- repeated row costs one extra row and nothing else. It also keeps the workspace-wide row of a view
-- created private and shared in one transaction.
CREATE OR REPLACE FUNCTION mark_change(p_workspace uuid, p_entity text, p_id uuid, p_user uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_workspace IS NULL OR p_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO changes(workspace_id, entity, entity_id, user_id)
    VALUES (p_workspace, p_entity, p_id, p_user);
    PERFORM pg_notify('blackwall_changes', p_workspace::text);
END;
$$;
