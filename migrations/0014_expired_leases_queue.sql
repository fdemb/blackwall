CREATE INDEX jobs_expired_leases_queue ON jobs(queue, lease_expires_at, id) WHERE state = 'running';
