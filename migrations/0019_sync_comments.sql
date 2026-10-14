-- A remote comment links to at most one local comment per connection, whether it was
-- sent from here or imported.
CREATE UNIQUE INDEX comments_sync_identity ON comments((sync->>'connection_id'),(sync->>'remote_id')) WHERE sync IS NOT NULL;
