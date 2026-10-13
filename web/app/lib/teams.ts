import type { TeamColor, TeamIcon } from "./types";

/** Mirrors `TEAM_ICONS` in `src/domain.rs`. The first is the default for new teams. */
export const TEAM_ICONS = [
  "users",
  "rocket",
  "code",
  "palette",
  "megaphone",
  "shield",
  "server",
  "database",
  "bug",
  "flask",
  "briefcase",
  "headset",
  "globe",
  "zap",
  "book",
  "wrench",
  "chart",
  "heart",
  "cpu",
  "smartphone",
  "layers",
  "target",
  "compass",
  "leaf",
] as const;

/** Mirrors `TEAM_COLORS` in `src/domain.rs`, in assignment order. */
export const TEAM_COLORS = [
  "violet",
  "blue",
  "sky",
  "teal",
  "green",
  "lime",
  "amber",
  "orange",
  "red",
  "pink",
  "fuchsia",
  "slate",
] as const;

/** The first palette color used by the fewest of `taken`, as the server assigns it. */
export function leastUsedTeamColor(taken: Iterable<string>): TeamColor {
  const counts: number[] = TEAM_COLORS.map(() => 0);
  for (const color of taken) {
    const i = TEAM_COLORS.indexOf(color as TeamColor);
    if (i >= 0) counts[i]++;
  }
  return TEAM_COLORS[counts.indexOf(Math.min(...counts))];
}

export function isTeamIcon(value: unknown): value is TeamIcon {
  return TEAM_ICONS.includes(value as TeamIcon);
}

export function isTeamColor(value: unknown): value is TeamColor {
  return TEAM_COLORS.includes(value as TeamColor);
}
