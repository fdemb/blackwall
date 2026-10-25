ALTER TABLE notifications
    ADD COLUMN actor_id uuid REFERENCES users(id),
    ADD COLUMN fields jsonb NOT NULL DEFAULT '[]';
