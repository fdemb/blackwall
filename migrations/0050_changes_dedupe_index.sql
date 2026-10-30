-- no-transaction
-- One statement only: several run in an implicit transaction, which CONCURRENTLY rejects.
-- Store::connect drops an invalid leftover of this index before migrating.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS changes_dedupe ON changes(workspace_id, txid, entity, entity_id, (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)));
