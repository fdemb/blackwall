CREATE TABLE purged_issue_numbers(
 workspace_id uuid NOT NULL,
 team_id uuid NOT NULL,
 number bigint NOT NULL CHECK(number>0),
 PRIMARY KEY(workspace_id,team_id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE tracker_deleted_issues(
 connection_id uuid NOT NULL REFERENCES tracker_connections(id) ON DELETE CASCADE,
 remote_id text NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,remote_id)
);

CREATE INDEX issues_trash_purge ON issues(deleted_at,id) WHERE deleted_at IS NOT NULL;
CREATE INDEX notifications_issue ON notifications(workspace_id,issue_id);

-- Purging deletes activity, and replicas that loaded it need the tombstone.
DROP TRIGGER record_change ON activity;
CREATE TRIGGER record_change AFTER INSERT OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION record_change('activity');
