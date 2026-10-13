-- Writes made through a personal access token record which token acted for the user:
-- {"kind":"api"|"mcp","token_id":uuid,"name":text}. The public API sets blackwall.via for
-- the length of its transaction, so every insert path picks it up without passing it along.
ALTER TABLE activity ADD COLUMN via jsonb DEFAULT nullif(current_setting('blackwall.via', true), '')::jsonb;
ALTER TABLE comments ADD COLUMN via jsonb DEFAULT nullif(current_setting('blackwall.via', true), '')::jsonb;

-- Comment tokens read everything and may only write comments.
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_access_check;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_access_check CHECK(access IN ('read','comment','write'));
