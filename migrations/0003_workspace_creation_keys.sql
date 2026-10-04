CREATE TABLE workspace_creation_keys (
    actor uuid NOT NULL REFERENCES users(id),
    key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 200),
    name text NOT NULL,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor, key)
);
