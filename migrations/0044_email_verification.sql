ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now();

CREATE TABLE email_verifications(
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX email_verifications_user ON email_verifications(user_id);
CREATE INDEX email_verifications_expiry ON email_verifications(expires_at);
