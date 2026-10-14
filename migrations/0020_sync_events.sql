-- Poke the workspace's event streams on every change. PostgreSQL collapses
-- identical payloads within one transaction and drops them on rollback,
-- so many changes in one transaction produce one poke and rolled-back
-- changes produce none.
CREATE OR REPLACE FUNCTION mark_change(p_workspace uuid, p_entity text, p_id uuid, p_user uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO changes(workspace_id, entity, entity_id, user_id)
    SELECT p_workspace, p_entity, p_id, p_user
    WHERE p_workspace IS NOT NULL AND p_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM changes c
        WHERE c.workspace_id = p_workspace AND c.txid = pg_current_xact_id()::text::bigint
          AND c.entity = p_entity AND c.entity_id = p_id
    );
    IF p_workspace IS NOT NULL AND p_id IS NOT NULL THEN
        PERFORM pg_notify('blackwall_changes', p_workspace::text);
    END IF;
END;
$$;
