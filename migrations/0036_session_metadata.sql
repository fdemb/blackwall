ALTER TABLE sessions
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN last_seen_at timestamptz,
    ADD COLUMN user_agent text;

UPDATE sessions SET created_at = expires_at - interval '30 days';
