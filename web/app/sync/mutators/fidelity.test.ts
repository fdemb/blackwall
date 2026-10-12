import { describe, expect, it } from "vite-plus/test";
import type { Entity } from "../records";
import { admit, normalizeArgs } from "./index";
import { AT, OWNER, TEAM, PROJECT, STAGE_BACKLOG, seedStore, mutate } from "./fixtures";

function rejection(run: () => unknown, status: number, message: string): void {
  expect(run).toThrowError(expect.objectContaining({ status, message }));
}

describe("server argument fidelity", () => {
  it.each([
    ["create_issue", { input: { estimate: -1 } }, "invalid value: integer `-1`, expected u32"],
    [
      "update_issue",
      { patch: { estimate: 1.5 } },
      "invalid type: floating point `1.5`, expected u32",
    ],
    [
      "update_issue",
      { patch: { estimate: 4294967296 } },
      "invalid value: integer `4294967296`, expected u32",
    ],
    ["log_time", { minutes: -1 }, "invalid value: integer `-1`, expected u32"],
    ["update_time", { minutes: 0.5 }, "invalid type: floating point `0.5`, expected u32"],
    ["set_team_archive", { archive_after_days: -1 }, "invalid value: integer `-1`, expected u32"],
    ["create_stage", { position: 0.5 }, "invalid type: floating point `0.5`, expected i64"],
    [
      "update_stage",
      { position: 2 ** 63 },
      "invalid value: integer `9223372036854776000`, expected i64",
    ],
    ["add_comment", { attachments: [{ size: -1 }] }, "invalid value: integer `-1`, expected u64"],
    [
      "bulk_issues",
      { action: { update: { estimate: -1 } } },
      "invalid value: integer `-1`, expected u32",
    ],
  ])("rejects Rust integer violations in %s", (name, args, message) => {
    rejection(() => normalizeArgs(String(name), args), 400, String(message));
  });

  it("accepts unsigned bounds and signed negative positions", () => {
    expect(normalizeArgs("create_issue", { input: { estimate: 0xffff_ffff } })).toMatchObject({
      input: { estimate: 0xffff_ffff },
    });
    expect(normalizeArgs("create_stage", { position: -1 })).toMatchObject({ position: -1 });
  });

  it.each([
    ["create_issue", { input: { deadline: "2026-10-08T12:00:00" } }],
    ["update_issue", { patch: { deadline: "2026-10-08T12:00:00" } }],
    ["create_milestone", { deadline: "2026-10-08T12:00:00" }],
    ["create_sprint", { starts_at: "2026-10-08T12:00:00" }],
    ["update_sprint", { ends_at: "2026-10-08T12:00:00" }],
    ["log_time", { logged_at: "2026-10-08T12:00:00" }],
  ])("requires explicit command timezone in %s", (name, args) => {
    rejection(() => normalizeArgs(String(name), args), 400, "premature end of input");
  });

  it.each(["Z", "z", "+02:30", "+0230", "-05:00", " UTC", "−0230", " +02::30"])(
    "accepts chrono timezone %s",
    (zone) => {
      expect(() =>
        normalizeArgs("create_issue", { input: { deadline: `2026-10-08T12:00:00${zone}` } }),
      ).not.toThrow();
    },
  );

  it.each([
    ["update_issue", { id: "issue-1", patch: { estimate: -1 } }],
    ["log_time", { id: "new-time", issue_id: "issue-1", minutes: -1, logged_at: AT }],
  ] as const)("rejects negative unsigned arguments during %s admission", (name, args) => {
    const store = seedStore(OWNER);
    rejection(
      () => admit(store, OWNER, { name, args, at: AT }),
      400,
      "invalid value: integer `-1`, expected u32",
    );
    expect(store.pending()).toHaveLength(0);
  });

  it("stores accepted relaxed command timestamps in UTC during replay", () => {
    const store = seedStore(OWNER);
    const args = { id: "issue-1", patch: { deadline: "2026-10-08T12: 00:00 UTC" } };
    expect(() => admit(store, OWNER, { name: "update_issue", args, at: AT })).not.toThrow();
    mutate(store, "update_issue", args);
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("issues", "issue-1")?.deadline).toBe("2026-10-08T12:00:00.000000Z");
  });

  it("rejects timezone-free deadlines before adding the mutation to the outbox", () => {
    const store = seedStore(OWNER);
    rejection(
      () =>
        admit(store, OWNER, {
          name: "update_issue",
          args: { id: "issue-1", patch: { deadline: "2026-10-08T12:00:00" } },
          at: AT,
        }),
      400,
      "premature end of input",
    );
    expect(store.pending()).toHaveLength(0);
  });
});

const CREATES = [
  [
    "create_team",
    { id: TEAM, name: "Team", members: [], default_stage_ids: ["s1", "s2", "s3", "s4"] },
  ],
  [
    "create_stage",
    { id: STAGE_BACKLOG, team_id: TEAM, name: "Stage", kind: "backlog", position: 0 },
  ],
  ["create_label", { id: "label-1", name: "Label", color: "red" }],
  ["create_project", { id: PROJECT, name: "Project", team_ids: [TEAM] }],
  ["create_milestone", { id: "milestone-1", project_id: PROJECT, name: "Milestone" }],
  [
    "create_sprint",
    {
      id: "sprint-1",
      team_id: TEAM,
      name: "Sprint",
      goal: "",
      starts_at: "2026-10-08T00:00:00Z",
      ends_at: AT,
    },
  ],
  ["create_issue", { input: { id: "issue-1", title: "Issue", team_id: TEAM } }],
  ["add_comment", { id: "comment-1", issue_id: "issue-1", body: "Comment" }],
  ["log_time", { id: "time-1", issue_id: "issue-1", minutes: 10, logged_at: AT }],
  ["save_view", { id: "view-1", name: "View", shared: false, filter: {} }],
] as const;

describe("create admission fidelity", () => {
  it.each(CREATES)(
    "rejects an existing id on admission and keeps replay upserts for %s",
    (name, args) => {
      const store = seedStore(OWNER);
      rejection(() => admit(store, OWNER, { name, args, at: AT }), 409, "id already exists");
      mutate(store, name, args);
      expect(store.replayErrors().size).toBe(0);
    },
  );

  it("rejects a cross-entity or default-stage collision", () => {
    const store = seedStore(OWNER);
    rejection(
      () =>
        admit(store, OWNER, {
          name: "create_label",
          args: { id: TEAM, name: "Label", color: "red" },
          at: AT,
        }),
      409,
      "id already exists",
    );
    rejection(
      () =>
        admit(store, OWNER, {
          name: "create_team",
          args: {
            id: "new",
            name: "Team",
            members: [],
            default_stage_ids: [STAGE_BACKLOG, "s2", "s3", "s4"],
          },
          at: AT,
        }),
      409,
      "id already exists",
    );
  });
});

function capacityRows<E extends Entity>(
  store: ReturnType<typeof seedStore>,
  entity: E,
  maximum: number,
): void {
  const row = store.all(entity)[0];
  if (!row) throw new Error(`missing ${entity} fixture`);
  // Existing rows plus these copies reach the SQL count, including deleted rows.
  const extra = maximum - store.all(entity).length;
  store.applyBase(
    Array.from({ length: extra }, (_, i) => ({
      entity,
      id: `capacity-${i}`,
      record: { ...row, id: `capacity-${i}` },
    })),
  );
}

describe("replica capacity fidelity", () => {
  it("rejects a 101st stage and permits replay of an existing stage at capacity", () => {
    const store = seedStore(OWNER);
    const team = store.get("teams", TEAM);
    if (!team) throw new Error("missing team");
    const stage = team.stages[0];
    store.applyBase([
      {
        entity: "teams",
        id: TEAM,
        record: {
          ...team,
          stages: [
            ...team.stages,
            ...Array.from({ length: 100 - team.stages.length }, (_, i) => ({
              ...stage,
              id: `extra-${i}`,
            })),
          ],
        },
      },
    ]);
    const args = { id: "new-stage", team_id: TEAM, name: "Stage", kind: "backlog", position: 100 };
    rejection(
      () => admit(store, OWNER, { name: "create_stage", args, at: AT }),
      400,
      "team must contain 1 to 100 stages",
    );
    mutate(store, "create_stage", { ...args, id: stage.id });
    expect(store.replayErrors().size).toBe(0);
  });

  it.each([
    [
      "teams",
      200,
      "create_team",
      { id: "new", name: "Team", members: [], default_stage_ids: ["s1", "s2", "s3", "s4"] },
    ],
    ["labels", 1000, "create_label", { id: "new", name: "Label", color: "red" }],
    ["projects", 1000, "create_project", { id: "new", name: "Project", team_ids: [TEAM] }],
    ["milestones", 5000, "create_milestone", { id: "new", name: "Milestone", project_id: PROJECT }],
    [
      "sprints",
      2000,
      "create_sprint",
      {
        id: "new",
        team_id: TEAM,
        name: "Sprint",
        goal: "",
        starts_at: "2026-10-08T00:00:00Z",
        ends_at: AT,
      },
    ],
    ["issues", 5000, "create_issue", { input: { id: "new", team_id: TEAM, title: "Issue" } }],
    [
      "time_entries",
      20000,
      "log_time",
      { id: "new", issue_id: "issue-1", minutes: 10, logged_at: AT },
    ],
  ] as const)("rejects workspace capacity for %s", (entity, maximum, name, args) => {
    const store = seedStore(OWNER);
    capacityRows(store, entity, maximum);
    rejection(() => admit(store, OWNER, { name, args, at: AT }), 400, "workspace capacity reached");
  });
});
