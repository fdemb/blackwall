import type { Id, Role } from "~/lib/types";

export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export type RoleFilter = Role | "all";
export const ROLE_FILTERS: RoleFilter[] = ["all", ...ROLES];

export interface MemberEntry {
  user_id: Id;
  role: Role;
  display_name: string;
  email: string;
}

/** Lowercase without accents, so "wisniewska" finds "Wiśniewska". */
function fold(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

export function roleCounts(rows: readonly MemberEntry[]): Record<RoleFilter, number> {
  const counts: Record<RoleFilter, number> = {
    all: rows.length,
    owner: 0,
    admin: 0,
    member: 0,
    viewer: 0,
  };
  for (const row of rows) counts[row.role] += 1;
  return counts;
}

/** Rows with the chosen role whose name or email contains the query, in their original order. */
export function filterMembers<T extends MemberEntry>(
  rows: readonly T[],
  filter: RoleFilter,
  query: string,
): T[] {
  const needle = fold(query.trim());
  return rows.filter(
    (row) =>
      (filter === "all" || row.role === filter) &&
      (fold(row.display_name).includes(needle) || fold(row.email).includes(needle)),
  );
}
