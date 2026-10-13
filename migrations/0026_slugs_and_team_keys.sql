-- Workspaces are addressed by slug in app URLs. Slugs are global, lowercase and hyphenated.
ALTER TABLE workspaces ADD COLUMN slug text;

WITH base AS (
    SELECT id, COALESCE(NULLIF(trim(BOTH '-' FROM left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 40)), ''), 'workspace') AS slug
    FROM workspaces
), numbered AS (
    SELECT id, slug, row_number() OVER (PARTITION BY slug ORDER BY id) AS n FROM base
)
UPDATE workspaces w
SET slug = CASE
    WHEN n = 1 AND numbered.slug NOT IN ('api', 'assets', 'health', 'internal-api', 'login', 'mcp', 'recover', 'register', 'welcome') THEN numbered.slug
    ELSE numbered.slug || '-' || left(w.id::text, 6)
END
FROM numbered
WHERE numbered.id = w.id;

ALTER TABLE workspaces ALTER COLUMN slug SET NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 48);
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug UNIQUE (slug);

-- Team keys prefix issue numbers, as in ENG-42.
ALTER TABLE teams ADD COLUMN key text;

WITH base AS (
    SELECT id, workspace_id, COALESCE(NULLIF(left(regexp_replace(regexp_replace(upper(name), '[^A-Z0-9]', '', 'g'), '^[0-9]+', ''), 3), ''), 'T') AS key
    FROM teams
), numbered AS (
    SELECT b.id, b.key, row_number() OVER (PARTITION BY b.workspace_id, b.key ORDER BY t.name, t.id) AS n
    FROM base b JOIN teams t ON t.id = b.id
)
UPDATE teams t
SET key = CASE WHEN n = 1 THEN numbered.key ELSE left(numbered.key, 4 - length(n::text)) || n END
FROM numbered
WHERE numbered.id = t.id;

ALTER TABLE teams ALTER COLUMN key SET NOT NULL;
ALTER TABLE teams ADD CONSTRAINT teams_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{0,3}$');
ALTER TABLE teams ADD CONSTRAINT teams_key UNIQUE (workspace_id, key);

-- Issue numbers count up per team. Existing numbers were unique per workspace, so they stay.
-- The next number is the team's highest plus one, which the client can predict from its replica.
ALTER TABLE issues DROP CONSTRAINT issues_workspace_id_number_key;
ALTER TABLE issues ADD CONSTRAINT issues_team_number UNIQUE (workspace_id, team_id, number);
CREATE INDEX issues_number ON issues(workspace_id, number);
ALTER TABLE workspaces DROP COLUMN next_issue_number;
