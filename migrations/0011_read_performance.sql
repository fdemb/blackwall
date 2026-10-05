CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX issues_substring_search ON issues
 USING gin ((title || ' ' || description) gin_trgm_ops);
CREATE INDEX issues_updated_active ON issues(workspace_id,updated_at DESC,id)
 WHERE deleted_at IS NULL AND archived_at IS NULL;
