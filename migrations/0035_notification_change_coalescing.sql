-- Unread change notifications coalesce on the key 'change:<issue>:<user>'. The newest unread
-- one per issue and recipient takes that key. Older unread duplicates stay as they are.
UPDATE notifications n
SET dedup_key = 'change:' || n.issue_id || ':' || n.user_id
FROM (
    SELECT DISTINCT ON (workspace_id, user_id, issue_id) id
    FROM notifications
    WHERE kind = 'change' AND read_at IS NULL AND issue_id IS NOT NULL
    ORDER BY workspace_id, user_id, issue_id, created_at DESC, id DESC
) newest
WHERE n.id = newest.id;

-- Reading a change notification releases the coalescing key, so the next change opens a fresh
-- notification instead of reviving one the recipient already read. A trigger covers mark read
-- and mark all read alike.
CREATE FUNCTION notifications_release_change_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.dedup_key := 'change:' || NEW.issue_id || ':' || NEW.user_id || ':' || NEW.id;
    RETURN NEW;
END
$$;

CREATE TRIGGER notifications_release_change_key
BEFORE UPDATE OF read_at ON notifications
FOR EACH ROW
WHEN (NEW.kind = 'change' AND OLD.read_at IS NULL AND NEW.read_at IS NOT NULL)
EXECUTE FUNCTION notifications_release_change_key();
