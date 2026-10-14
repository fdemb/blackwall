/** Workspace slugs and team keys: the names URLs and issue keys use. Rules mirror `src/domain.rs`. */

/** Top-level paths a workspace slug would shadow. Mirrors `RESERVED_SLUGS`. */
const RESERVED_SLUGS = new Set([
  "api",
  "assets",
  "health",
  "internal-api",
  "login",
  "mcp",
  "recover",
  "register",
  "welcome",
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,3}$/;
const ISSUE_KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,3})-([1-9][0-9]*)$/;

export const SLUG_MAX = 48;
export const TEAM_KEY_MAX = 4;

/** ASCII letters for accented ones, so "Zespół" suggests "zespol". */
function plain(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L");
}

export function isWorkspaceSlug(slug: string) {
  return slug.length <= SLUG_MAX && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** The slug suggested for a workspace name: lowercase runs of letters and digits joined by hyphens. */
export function workspaceSlug(name: string) {
  const slug = plain(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return RESERVED_SLUGS.has(slug) ? `${slug}-workspace` : slug;
}

/** What a slug field accepts while typing: lowercase, with anything else turned into hyphens. */
export function slugInput(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, SLUG_MAX);
}

export function isTeamKey(key: string) {
  return TEAM_KEY_RE.test(key);
}

/** The key suggested for a team name: its first three letters or digits, skipping leading digits. */
export function teamKey(name: string) {
  return plain(name)
    .replace(/[^A-Za-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 3)
    .toUpperCase();
}

/** `base`, or `base` with a number replacing its tail, whichever `taken` lacks first. Mirrors `unique_team_key`. */
export function freeTeamKey(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const key = base.slice(0, TEAM_KEY_MAX - suffix.length) + suffix;
    if (!taken.has(key)) return key;
  }
  return base;
}

/** What a key field accepts while typing: uppercase letters and digits, at most four. */
export function teamKeyInput(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, TEAM_KEY_MAX);
}

/** `ENG-42` split into its team key and number, or null for anything else. Case-insensitive. */
export function parseIssueKey(value: string): { team: string; number: number } | null {
  const match = ISSUE_KEY_RE.exec(value);
  if (!match) return null;
  return { team: match[1].toUpperCase(), number: Number(match[2]) };
}
