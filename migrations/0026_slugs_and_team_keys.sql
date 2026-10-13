-- Workspaces are addressed by slug in app URLs. Slugs are global, lowercase and hyphenated.
-- Team keys prefix issue numbers, as in ENG-42, and are unique per workspace.
ALTER TABLE workspaces ADD COLUMN slug text;
ALTER TABLE teams ADD COLUMN key text;

-- Each row first claims the value its name suggests, unless that is reserved or an earlier row
-- (by id) claimed it. The rest take the first numbered variant that no row holds yet, checked
-- against every value already assigned in the same uniqueness scope.
DO $$
DECLARE
    reserved CONSTANT text[] := ARRAY['api', 'assets', 'health', 'internal-api', 'login', 'mcp', 'recover', 'register', 'welcome'];
    item record;
    candidate text;
    n int;
BEGIN
    CREATE TEMP TABLE suggested_slugs ON COMMIT DROP AS
    SELECT id, COALESCE(NULLIF(trim(BOTH '-' FROM left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 48)), ''), 'workspace') AS base
    FROM workspaces;

    UPDATE workspaces w SET slug = s.base
    FROM (SELECT DISTINCT ON (base) id, base FROM suggested_slugs ORDER BY base, id) s
    WHERE w.id = s.id AND NOT s.base = ANY(reserved);

    FOR item IN SELECT s.id, s.base FROM suggested_slugs s JOIN workspaces w USING (id) WHERE w.slug IS NULL ORDER BY s.id LOOP
        n := 1;
        LOOP
            n := n + 1;
            candidate := rtrim(left(item.base, 47 - length(n::text)), '-') || '-' || n;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = candidate);
        END LOOP;
        UPDATE workspaces SET slug = candidate WHERE id = item.id;
    END LOOP;

    CREATE TEMP TABLE suggested_keys ON COMMIT DROP AS
    SELECT id, workspace_id, COALESCE(NULLIF(left(regexp_replace(regexp_replace(upper(name), '[^A-Z0-9]', '', 'g'), '^[0-9]+', ''), 3), ''), 'T') AS base
    FROM teams;

    UPDATE teams t SET key = s.base
    FROM (SELECT DISTINCT ON (workspace_id, base) id, base FROM suggested_keys ORDER BY workspace_id, base, id) s
    WHERE t.id = s.id;

    FOR item IN SELECT s.id, s.workspace_id, s.base FROM suggested_keys s JOIN teams t USING (id) WHERE t.key IS NULL ORDER BY s.workspace_id, s.id LOOP
        n := 1;
        LOOP
            n := n + 1;
            candidate := left(item.base, 4 - length(n::text)) || n;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM teams WHERE workspace_id = item.workspace_id AND key = candidate);
        END LOOP;
        UPDATE teams SET key = candidate WHERE id = item.id;
    END LOOP;
END
$$;

ALTER TABLE workspaces ALTER COLUMN slug SET NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 48);
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug UNIQUE (slug);

ALTER TABLE teams ALTER COLUMN key SET NOT NULL;
ALTER TABLE teams ADD CONSTRAINT teams_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{0,3}$');
ALTER TABLE teams ADD CONSTRAINT teams_key UNIQUE (workspace_id, key);

-- Issue numbers count up per team. Existing numbers were unique per workspace, so they stay.
-- The next number is the team's highest plus one, which the client can predict from its replica.
ALTER TABLE issues DROP CONSTRAINT issues_workspace_id_number_key;
ALTER TABLE issues ADD CONSTRAINT issues_team_number UNIQUE (workspace_id, team_id, number);
CREATE INDEX issues_number ON issues(workspace_id, number);
ALTER TABLE workspaces DROP COLUMN next_issue_number;
