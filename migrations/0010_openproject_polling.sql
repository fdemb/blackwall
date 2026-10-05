ALTER TABLE openproject_connections
 ADD COLUMN poll_watermark timestamptz,
 ADD COLUMN last_discovered_at timestamptz,
 ADD COLUMN incremental_supported boolean NOT NULL DEFAULT true;

-- Legacy discovery checkpoints stored earlier pages directly in the public cache.
-- Restart them, and fence in-flight leases, before using the separate page store.
WITH restarted AS (
 UPDATE openproject_connections
 SET generation=generation+1,
     checkpoint='{"phase":"projects","page":1,"refresh_only":false}'::jsonb,
     next_run_at=clock_timestamp(),status='pending',last_error=''
 WHERE enabled AND NOT deleted
 RETURNING id
)
UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE queue='openproject' AND state='pending'
 AND payload->>'connection_id' IN (SELECT id::text FROM restarted);

-- Keep discovery pages separate until the resource has been completely fetched.
-- Updating the checkpoint never needs to rewrite an accumulated JSON cache.
CREATE TABLE openproject_discovery_pages (
 connection_id uuid NOT NULL REFERENCES openproject_connections(id) ON DELETE CASCADE,
 generation bigint NOT NULL,
 resource text NOT NULL CHECK(resource IN ('projects','statuses','users')),
 page bigint NOT NULL CHECK(page BETWEEN 1 AND 1000),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=5000),
 PRIMARY KEY(connection_id,generation,resource,page)
);
