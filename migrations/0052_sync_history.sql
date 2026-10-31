-- Names the database history sync cursors belong to. A restore into a new cluster resets txids to
-- low values, and a failover can hand out txids a client's cursor already counts as delivered.
-- Cursors carry `epoch`; the server rotates it, and drops the change rows, once `sync_identity()`
-- differs from the `cluster` value stored at the last rotation. A restore copies this table, so
-- the stored `cluster` is what exposes the move to another history.
CREATE FUNCTION sync_identity() RETURNS text LANGUAGE sql AS $$
    SELECT (SELECT system_identifier FROM pg_control_system())::text
        || '/' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8)
$$;

CREATE TABLE sync_history (
    singleton bool PRIMARY KEY DEFAULT true CHECK (singleton),
    epoch uuid NOT NULL DEFAULT gen_random_uuid(),
    cluster text NOT NULL
);
INSERT INTO sync_history(cluster) VALUES (sync_identity());
