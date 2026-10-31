ALTER TABLE sync_clients
    DROP CONSTRAINT sync_clients_workspace_id_fkey,
    ADD CONSTRAINT sync_clients_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    DROP CONSTRAINT sync_clients_user_id_fkey,
    ADD CONSTRAINT sync_clients_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX sync_clients_updated;
