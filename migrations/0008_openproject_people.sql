ALTER TABLE openproject_connections ADD COLUMN people_mapping jsonb NOT NULL DEFAULT '{}';
ALTER TABLE openproject_connections ADD COLUMN cached_people jsonb NOT NULL DEFAULT '[]';
