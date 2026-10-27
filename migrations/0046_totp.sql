-- enabled_at stays NULL while setup waits for the first valid code.
-- last_step is the newest accepted time step, so a code can't be replayed.
CREATE TABLE user_totp(
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret bytea NOT NULL,
    enabled_at timestamptz,
    last_step bigint
);

CREATE TABLE totp_recovery_codes(
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    PRIMARY KEY(user_id, code_hash)
);

-- A correct password on an account with TOTP, waiting for its second factor.
CREATE TABLE pending_logins(
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    failed_attempts int NOT NULL DEFAULT 0
);
CREATE INDEX pending_logins_user ON pending_logins(user_id);
CREATE INDEX pending_logins_expiry ON pending_logins(expires_at);
