ALTER TABLE alert_preferences
    ADD COLUMN email_assignment bool NOT NULL DEFAULT true,
    ADD COLUMN email_reply bool NOT NULL DEFAULT true,
    ADD COLUMN email_change bool NOT NULL DEFAULT false,
    ADD COLUMN email_mention bool NOT NULL DEFAULT true,
    ADD COLUMN email_deadline bool NOT NULL DEFAULT true;

-- The profile-wide switches stop gating the inbox, so fold them into each workspace's row.
-- profile.alerts stays in place for a binary that still reads it.
CREATE TEMPORARY TABLE profile_alerts ON COMMIT DROP AS
SELECT id AS user_id,
       COALESCE((profile->'alerts'->>'assignments')::bool, true) AS assignments,
       COALESCE((profile->'alerts'->>'replies')::bool, true) AS replies,
       COALESCE((profile->'alerts'->>'changes')::bool, true) AS changes,
       COALESCE((profile->'alerts'->>'deadlines')::bool, true) AS deadlines
FROM users
WHERE jsonb_typeof(profile->'alerts') = 'object';

DELETE FROM profile_alerts WHERE assignments AND replies AND changes AND deadlines;

UPDATE alert_preferences p
SET assignment = p.assignment AND g.assignments,
    reply = p.reply AND g.replies,
    change = p.change AND g.changes,
    mention = p.mention AND g.replies,
    deadline = p.deadline AND g.deadlines,
    version = p.version + 1
FROM profile_alerts g
WHERE g.user_id = p.user_id
  AND ((p.assignment AND NOT g.assignments)
    OR (p.reply AND NOT g.replies)
    OR (p.change AND NOT g.changes)
    OR (p.mention AND NOT g.replies)
    OR (p.deadline AND NOT g.deadlines));

INSERT INTO alert_preferences(workspace_id, user_id, assignment, reply, change, mention, deadline)
SELECT m.workspace_id, m.user_id, g.assignments, g.replies, g.changes, g.replies, g.deadlines
FROM workspace_members m
JOIN profile_alerts g ON g.user_id = m.user_id
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- How far each member's unread notifications have been emailed. Not synced to clients.
CREATE TABLE notification_digests(
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    sent_through timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);

-- The digest sweep reads recent unread notifications across every workspace,
-- which notifications_inbox, keyed by workspace first, can't range-scan.
CREATE INDEX notifications_unread_created ON notifications(created_at) WHERE read_at IS NULL;
