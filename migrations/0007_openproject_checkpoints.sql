-- Older scans reached work_packages even when no projects were mapped.
-- Restart discovery so the tagged scan can finish without an unfiltered request.
WITH restarted AS (
 UPDATE openproject_connections
 SET checkpoint='{"phase":"projects","page":1,"refresh_only":false}'::jsonb,
     generation=generation+1,
     next_run_at=clock_timestamp(),
     status='pending',last_error=''
 WHERE projects='[]'::jsonb AND checkpoint->>'phase'='work_packages'
 RETURNING id
)
UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE queue='openproject' AND state='pending'
 AND payload->>'connection_id' IN (SELECT id::text FROM restarted);
