-- Local changes waiting to be sent to the remote tracker. Rows name fields, not values:
-- the push reads current local values. At most one pending `fields` row per issue.
CREATE TABLE tracker_outbox(
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES tracker_connections(id) ON DELETE CASCADE,
 issue_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('fields','comment')),
 fields text[] NOT NULL DEFAULT '{}',
 comment_id uuid,
 -- Bumped when more fields coalesce into the row, so a push in flight keeps newer edits.
 revision bigint NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,
 last_error text NOT NULL DEFAULT '',
 attempted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='comment')=(comment_id IS NOT NULL)),
 FOREIGN KEY(workspace_id,issue_id) REFERENCES issues(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,comment_id) REFERENCES comments(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX tracker_outbox_fields ON tracker_outbox(connection_id,issue_id) WHERE kind='fields';
CREATE INDEX tracker_outbox_drain ON tracker_outbox(connection_id,created_at,id);
CREATE INDEX tracker_outbox_issue ON tracker_outbox(issue_id);

-- Remote identity of comments sent to or imported from a provider.
ALTER TABLE comments ADD COLUMN tracker jsonb;
