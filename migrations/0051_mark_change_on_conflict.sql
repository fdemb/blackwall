-- The unique index changes_dedupe makes the dedupe one probe instead of a scan of the transaction's
-- earlier rows, because changes_feed ends in id.
CREATE OR REPLACE FUNCTION mark_change(p_workspace uuid, p_entity text, p_id uuid, p_user uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_workspace IS NULL OR p_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO changes(workspace_id, entity, entity_id, user_id)
    VALUES (p_workspace, p_entity, p_id, p_user)
    ON CONFLICT (workspace_id, txid, entity, entity_id,
                 (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    DO NOTHING;
    PERFORM pg_notify('blackwall_changes', p_workspace::text);
END;
$$;
