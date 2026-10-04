CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (octet_length(kind) BETWEEN 1 AND 64),
    payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 262144),
    queue text NOT NULL CHECK (queue IN ('email', 'webhook', 'database')),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
    run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
    claim_token uuid,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    dedup_key text UNIQUE CHECK (octet_length(dedup_key) <= 512),
    last_error text NOT NULL DEFAULT '' CHECK (octet_length(last_error) <= 2048),
    CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'running') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((state IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX jobs_pending_due ON jobs(queue,run_at,id) WHERE state = 'pending';
CREATE INDEX jobs_expired_leases ON jobs(lease_expires_at,id) WHERE state = 'running';
CREATE INDEX jobs_finished ON jobs(finished_at,id) WHERE finished_at IS NOT NULL;

CREATE FUNCTION notify_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state = 'pending' THEN
        PERFORM pg_notify('blackwall_jobs', '');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_wakeup AFTER INSERT OR UPDATE OF state,run_at ON jobs
    FOR EACH ROW EXECUTE FUNCTION notify_jobs();
