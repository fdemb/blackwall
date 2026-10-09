CREATE TABLE sync_rejections(
    client_id uuid NOT NULL REFERENCES sync_clients(client_id) ON DELETE CASCADE,
    mutation_id bigint NOT NULL,
    status smallint NOT NULL,
    message text NOT NULL,
    PRIMARY KEY (client_id, mutation_id)
);
