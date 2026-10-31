-- The notification carries the committing transaction's id next to the workspace, so an event stream
-- can tell a client whether its cursor already covers the commit. Identical payloads still collapse
-- within a transaction, so one transaction sends one notification per workspace.
CREATE OR REPLACE FUNCTION mark_change(p_workspace uuid, p_entity text, p_id uuid, p_user uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_workspace IS NULL OR p_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO changes(workspace_id, entity, entity_id, user_id)
    VALUES (p_workspace, p_entity, p_id, p_user);
    PERFORM pg_notify('blackwall_changes', p_workspace::text || ':' || pg_current_xact_id()::text);
END;
$$;
