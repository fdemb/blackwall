-- Per-team icon and color, validated against the allowlists in src/domain.rs.
ALTER TABLE teams ADD COLUMN icon text NOT NULL DEFAULT 'users' CHECK (length(icon) <= 40);
ALTER TABLE teams ADD COLUMN color text NOT NULL DEFAULT 'violet' CHECK (length(color) <= 40);

-- Spread existing teams across the palette so each starts with its own color.
UPDATE teams t
SET color = (ARRAY['violet','blue','sky','teal','green','lime','amber','orange','red','pink','fuchsia','slate'])[r.n % 12 + 1],
    version = t.version + 1
FROM (SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY name, id) - 1 AS n FROM teams) r
WHERE r.id = t.id;
