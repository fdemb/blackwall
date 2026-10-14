-- A remote comment links to at most one local comment per connection, whether it was
-- sent from here or imported.
CREATE UNIQUE INDEX comments_tracker_identity ON comments((tracker->>'connection_id'),(tracker->>'remote_id')) WHERE tracker IS NOT NULL;
