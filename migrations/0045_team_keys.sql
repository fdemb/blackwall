-- Every key a team has used, current and retired. A retired key keeps
-- resolving its issue keys and stays reserved for that team, so no other
-- team can take it and answer to old links.
CREATE TABLE team_keys(
 workspace_id uuid NOT NULL,
 key text NOT NULL,
 team_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,key),
 FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX team_keys_team ON team_keys(workspace_id,team_id);
INSERT INTO team_keys(workspace_id,key,team_id) SELECT workspace_id,key,id FROM teams;

-- Raises on teams_key so callers report it like a clash with a current key.
-- Loops because the conflicting row can be deleted between the insert and
-- the read, and the key still needs its row.
CREATE FUNCTION claim_team_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    owner uuid;
BEGIN
    LOOP
        INSERT INTO team_keys(workspace_id,key,team_id) VALUES(NEW.workspace_id,NEW.key,NEW.id)
            ON CONFLICT DO NOTHING;
        SELECT team_id INTO owner FROM team_keys WHERE workspace_id=NEW.workspace_id AND key=NEW.key;
        IF FOUND THEN
            IF owner <> NEW.id THEN
                RAISE unique_violation USING CONSTRAINT = 'teams_key', MESSAGE = 'team key already exists';
            END IF;
            RETURN NULL;
        END IF;
    END LOOP;
END;
$$;
CREATE TRIGGER claim_team_key AFTER INSERT OR UPDATE OF key ON teams
    FOR EACH ROW EXECUTE FUNCTION claim_team_key();
