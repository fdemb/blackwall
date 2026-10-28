-- Webhooks made before deliveries carried `data` keep sending ids only until an admin opts in.
ALTER TABLE integrations ADD COLUMN include_data bool NOT NULL DEFAULT false;
ALTER TABLE integrations ALTER COLUMN include_data SET DEFAULT true;
