-- A comment push that may have reached the provider: set before each send, with the body
-- and the remote account it sent, and cleared when the send was refused. Retries adopt
-- the remote copy instead of posting again, and imports hold back that account's comments
-- on the issue meanwhile; every comment when the account is unknown.
ALTER TABLE sync_outbox ADD COLUMN sent_at timestamptz, ADD COLUMN sent_body text, ADD COLUMN sent_account text;
-- Comment rows attempted before may have reached the provider.
UPDATE sync_outbox o SET sent_at=COALESCE(o.attempted_at,now()),sent_body=c.body FROM comments c WHERE o.kind='comment' AND (o.attempts>0 OR o.attempted_at IS NOT NULL) AND c.workspace_id=o.workspace_id AND c.id=o.comment_id;
ALTER TABLE sync_outbox ADD CHECK((sent_at IS NULL)=(sent_body IS NULL));
-- When a failed row is due again. Kept apart from `attempts`, which counts only the
-- failures that lead to giving up: credential and permission problems wait without it.
ALTER TABLE sync_outbox ADD COLUMN retry_at timestamptz;
UPDATE sync_outbox SET retry_at=attempted_at+make_interval(secs=>least(30*power(2,attempts-1),3600)) WHERE attempted_at IS NOT NULL;
ALTER TABLE sync_outbox DROP COLUMN attempted_at;
-- The integration account's remote user, looked up once until the credentials change,
-- and why queued changes cannot be sent, apart from scan errors.
ALTER TABLE sync_connections ADD COLUMN remote_user_id text, ADD COLUMN push_error text;
-- Comment history import is recorded apart from the remote modification time, which a
-- provider may omit. Earlier checkpoints could record imports that skipped comments at
-- the workspace limit, so every linked package is listed once more; history already
-- imported still notifies nobody.
UPDATE issues SET sync=(sync-'comments_at')||'{"comments_imported":true}' WHERE sync ? 'comments_at';
