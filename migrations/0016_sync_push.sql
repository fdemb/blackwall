ALTER TABLE sessions ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

CREATE TABLE sync_clients(
    client_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    last_mutation_id bigint NOT NULL DEFAULT 0 CHECK (last_mutation_id >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_clients_updated ON sync_clients(updated_at);
