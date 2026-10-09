import type { Id, Stage } from "./types";

// PostgreSQL sorts `name` with the database collation, en_US.utf8 here. Ignoring punctuation at
// the first level matches it. When the collation calls two names equal, PostgreSQL falls back to
// byte order, which is what compareCodePoints does.
const text = new Intl.Collator("en-US", { ignorePunctuation: true });

/** Byte order of UTF-8 text, which equals code point order. Ids and timestamps are ASCII. */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = orderUnit(a.charCodeAt(index));
    const right = orderUnit(b.charCodeAt(index));
    if (left !== right) return left - right;
  }
  return a.length - b.length;
}

// UTF-16 units sort surrogates below U+E000..U+FFFF, but code points sort them above.
function orderUnit(unit: number): number {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}

/** Compares names the way `ORDER BY name` does on the server. */
export function compareNames(a: string, b: string): number {
  return text.compare(a, b) || compareCodePoints(a, b);
}

type Keyed = { id: Id };

/** Ascending name, then id. Used by teams, labels, projects, milestones, views and integrations. */
export function byName<T extends Keyed & { name: string }>(a: T, b: T): number {
  return compareNames(a.name, b.name) || compareCodePoints(a.id, b.id);
}

/** Stages inside a team, in the server's `position, id` order. */
export function byPosition(a: Pick<Stage, "id" | "position">, b: Pick<Stage, "id" | "position">) {
  return a.position - b.position || compareCodePoints(a.id, b.id);
}

/** Workspace membership rows and alert preferences, ordered by user id. */
export function byUserId<T extends { user_id: Id }>(a: T, b: T): number {
  return compareCodePoints(a.user_id, b.user_id);
}

/** Member profiles, ordered by lowercased display name, then id. */
export function byDisplayName<T extends Keyed & { display_name: string }>(a: T, b: T): number {
  return (
    compareNames(a.display_name.toLowerCase(), b.display_name.toLowerCase()) ||
    compareCodePoints(a.id, b.id)
  );
}

/** Sprints, earliest start first. */
export function bySprintStart<T extends Keyed & { starts_at: string }>(a: T, b: T): number {
  return compareCodePoints(a.starts_at, b.starts_at) || compareCodePoints(a.id, b.id);
}

/** Invitations, latest expiry first. */
export function byExpiryDesc<T extends Keyed & { expires_at: string }>(a: T, b: T): number {
  return compareCodePoints(b.expires_at, a.expires_at) || compareCodePoints(a.id, b.id);
}

/** Notifications, newest first. */
export function byCreatedDesc<T extends Keyed & { created_at: string }>(a: T, b: T): number {
  return compareCodePoints(b.created_at, a.created_at) || compareCodePoints(a.id, b.id);
}

/** Comments, oldest first. */
export function byCreatedAsc<T extends Keyed & { created_at: string }>(a: T, b: T): number {
  return compareCodePoints(a.created_at, b.created_at) || compareCodePoints(a.id, b.id);
}

/** Activity, newest first. */
export function byAtDesc<T extends Keyed & { at: string }>(a: T, b: T): number {
  return compareCodePoints(b.at, a.at) || compareCodePoints(a.id, b.id);
}

/** Time entries, most recently logged first. */
export function byLoggedDesc<T extends Keyed & { logged_at: string }>(a: T, b: T): number {
  return compareCodePoints(b.logged_at, a.logged_at) || compareCodePoints(a.id, b.id);
}
