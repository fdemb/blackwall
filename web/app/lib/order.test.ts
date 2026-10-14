import { describe, expect, it } from "vite-plus/test";
import { postgresUrl, psqlRows, sqlText } from "../testing/postgres";
import {
  byAtDesc,
  byCreatedAsc,
  byCreatedDesc,
  byDisplayName,
  byExpiryDesc,
  byLoggedDesc,
  byName,
  byPosition,
  bySprintStart,
  byUserId,
  compareNames,
} from "./order";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Captured from PostgreSQL 17 on en_US.utf8: `ORDER BY name COLLATE "en_US"`.
const POSTGRES_NAME_ORDER = [
  "10",
  "2",
  "9",
  "a1",
  "a10",
  "a2",
  "a b",
  "a-b",
  "a.b",
  "a_b",
  "ab",
  "ab.",
  "aB",
  "abc",
  "Abc",
  "Ábc",
  "alpha",
  "Alpha",
  "Alpha ",
  "ALPHA",
  "emile",
  "Emile",
  "émile",
  "ss",
  "ß",
  "st",
  "strasse",
  "Straße",
  "#tag",
  "Unal",
  "Ünal",
  "Unan",
  "-x",
  "_x",
  "x_y",
  "zoe",
  "Zoe",
  "zoë",
  "Zulu",
  "中文",
  "日本",
];

describe("name order", () => {
  it("sorts names like PostgreSQL's en_US collation, with byte order for ties", () => {
    const shuffled = [...POSTGRES_NAME_ORDER].reverse();
    expect(shuffled.sort(compareNames)).toEqual(POSTGRES_NAME_ORDER);
  });

  it.skipIf(!postgresUrl)("agrees with PostgreSQL's ORDER BY name on the same names", () => {
    const rows = psqlRows(
      `select x from (values ${POSTGRES_NAME_ORDER.map((name) => `(${sqlText(name)})`).join(",")}) v(x) order by x collate "en_US"`,
    );
    expect(rows).toEqual(POSTGRES_NAME_ORDER);
  });
});

describe("collection order", () => {
  it("orders teams, labels and other named collections by name, then id", () => {
    const teams = [
      { id: id(2), name: "Zulu" },
      { id: id(3), name: "Alpha" },
      { id: id(1), name: "alpha" },
    ];
    expect(teams.sort(byName).map((team) => team.id)).toEqual([id(1), id(3), id(2)]);
  });

  it("orders stages by position, then id", () => {
    const stages = [
      { id: id(3), position: 1 },
      { id: id(2), position: 0 },
      { id: id(1), position: 1 },
    ];
    expect(stages.sort(byPosition).map((stage) => stage.id)).toEqual([id(2), id(1), id(3)]);
  });

  it("orders membership and alert rows by user id", () => {
    const rows = [{ user_id: id(2) }, { user_id: id(1) }];
    expect(rows.sort(byUserId).map((row) => row.user_id)).toEqual([id(1), id(2)]);
  });

  it("orders member profiles by lowercased display name, then id", () => {
    const members = [
      { id: id(3), display_name: "Bob" },
      { id: id(2), display_name: "alice" },
      { id: id(1), display_name: "Alice" },
      { id: id(4), display_name: "bob" },
    ];
    expect(members.sort(byDisplayName).map((member) => member.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ]);
  });

  it("orders sprints by earliest start, then id", () => {
    const sprints = [
      { id: id(2), starts_at: "2026-10-12T00:00:00.000000Z" },
      { id: id(3), starts_at: "2026-10-05T00:00:00.000000Z" },
      { id: id(1), starts_at: "2026-10-12T00:00:00.000000Z" },
    ];
    expect(sprints.sort(bySprintStart).map((sprint) => sprint.id)).toEqual([id(3), id(1), id(2)]);
  });

  it("orders invitations by latest expiry, then id", () => {
    const invitations = [
      { id: id(1), expires_at: "2026-10-12T00:00:00.000000Z" },
      { id: id(3), expires_at: "2026-10-20T00:00:00.000000Z" },
      { id: id(2), expires_at: "2026-10-12T00:00:00.000000Z" },
    ];
    expect(invitations.sort(byExpiryDesc).map((row) => row.id)).toEqual([id(3), id(1), id(2)]);
  });

  it("orders notifications newest first, then id", () => {
    const notifications = [
      { id: id(2), created_at: "2026-10-09T10:00:00.000000Z" },
      { id: id(1), created_at: "2026-10-09T10:00:00.000000Z" },
      { id: id(3), created_at: "2026-10-09T11:00:00.000000Z" },
    ];
    expect(notifications.sort(byCreatedDesc).map((row) => row.id)).toEqual([id(3), id(1), id(2)]);
  });

  it("orders comments oldest first, then id", () => {
    const comments = [
      { id: id(3), created_at: "2026-10-09T11:00:00.000000Z" },
      { id: id(2), created_at: "2026-10-09T10:00:00.000000Z" },
      { id: id(1), created_at: "2026-10-09T10:00:00.000000Z" },
    ];
    expect(comments.sort(byCreatedAsc).map((row) => row.id)).toEqual([id(1), id(2), id(3)]);
  });

  it("orders activity newest first, then id", () => {
    const activity = [
      { id: id(1), at: "2026-10-09T10:00:00.000000Z" },
      { id: id(2), at: "2026-10-09T10:00:00.000000Z" },
      { id: id(3), at: "2026-10-09T12:00:00.000000Z" },
    ];
    expect(activity.sort(byAtDesc).map((row) => row.id)).toEqual([id(3), id(1), id(2)]);
  });

  it("orders time entries most recently logged first, then id", () => {
    const entries = [
      { id: id(2), logged_at: "2026-10-08T09:00:00.000000Z" },
      { id: id(1), logged_at: "2026-10-09T09:00:00.000000Z" },
      { id: id(3), logged_at: "2026-10-08T09:00:00.000000Z" },
    ];
    expect(entries.sort(byLoggedDesc).map((row) => row.id)).toEqual([id(1), id(2), id(3)]);
  });
});
