-- mark_change deduped with NOT EXISTS over (workspace_id, txid, entity, entity_id), but changes_feed
-- ends in id, so each insert scanned every row its transaction had already written. A unique index
-- makes the dedupe one index probe. user_id is part of the key: a view created private and shared in
-- one transaction needs both its owner-only row and its workspace-wide row, and the old check dropped
-- whichever came second.
DELETE FROM changes WHERE id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (
            PARTITION BY workspace_id, txid, entity, entity_id,
                         COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY id) AS n
        FROM changes) ranked
    WHERE n > 1);

CREATE UNIQUE INDEX changes_dedupe ON changes(
    workspace_id, txid, entity, entity_id,
    (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)));

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
