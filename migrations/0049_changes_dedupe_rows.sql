-- changes_dedupe (next migration) is unique over this key. user_id is part of it: a view created
-- private and shared in one transaction needs both its owner-only row and its workspace-wide row.
-- The mark_change from 0020 still runs until 0051 and dedupes on a narrower key, so it cannot
-- write a duplicate of the wider one.
DELETE FROM changes WHERE id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (
            PARTITION BY workspace_id, txid, entity, entity_id,
                         COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY id) AS n
        FROM changes) ranked
    WHERE n > 1);
