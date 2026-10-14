DROP INDEX changes_feed;
CREATE INDEX changes_feed ON changes(workspace_id, txid, id);
