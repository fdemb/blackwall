-- Personal access tokens for the public /api/v1 surface and the MCP endpoint.
-- A token acts as its user, narrowed by access level and an optional workspace allowlist.
CREATE TABLE api_tokens(
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  access text NOT NULL CHECK(access IN ('read','write')),
  -- NULL allows every workspace the user belongs to.
  workspace_ids uuid[] CHECK(workspace_ids IS NULL OR cardinality(workspace_ids) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens(user_id, created_at);

-- Public webhook event types an integration receives. Empty means every event.
ALTER TABLE integrations ADD COLUMN events text[] NOT NULL DEFAULT '{}' CHECK(cardinality(events) <= 64);
