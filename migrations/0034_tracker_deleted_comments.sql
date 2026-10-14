-- Remote identities of synced comments deleted here, so imports do not bring them back.
CREATE TABLE tracker_deleted_comments(
 connection_id uuid NOT NULL REFERENCES tracker_connections(id) ON DELETE CASCADE,
 remote_id text NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,remote_id)
);
