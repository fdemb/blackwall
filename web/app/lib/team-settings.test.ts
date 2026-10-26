import { describe, expect, it } from "vite-plus/test";
import {
  archiveChoices,
  reorderStages,
  stageIssueCounts,
  teamForKeyParam,
  teamView,
} from "./team-settings";
import type { Stage, StageKind, Team } from "./types";

const stage = (id: string, kind: StageKind, position: number): Stage => ({
  id,
  version: 1,
  name: id,
  kind,
  position,
});

const team = (overrides: Partial<Team> = {}): Team => ({
  id: "team-eng",
  version: 1,
  name: "Engineering",
  key: "ENG",
  former_keys: [],
  members: ["u1", "u2"],
  stages: [
    stage("done", "done", 4),
    stage("backlog", "backlog", 1),
    stage("doing", "active", 3),
    stage("todo", "planned", 2),
    stage("cancelled", "cancelled", 5),
  ],
  archive_after_days: 30,
  icon: "code",
  color: "violet",
  ...overrides,
});

const issue = (stage_id: string, state: "live" | "archived" | "trashed" = "live") => ({
  stage_id,
  archived_at: state === "archived" ? "2026-10-01T00:00:00Z" : null,
  deleted_at: state === "trashed" ? "2026-10-01T00:00:00Z" : null,
});

describe("team view", () => {
  const counts = stageIssueCounts([
    issue("backlog"),
    issue("backlog"),
    issue("todo"),
    issue("doing"),
    issue("doing", "archived"),
    issue("todo", "trashed"),
    issue("done"),
    issue("done"),
    issue("cancelled"),
  ]);
  const view = teamView(team(), counts);

  it("lists stages in board order with live issue counts", () => {
    expect(view.stages.map(({ stage, issues }) => [stage.id, issues])).toEqual([
      ["backlog", 2],
      ["todo", 1],
      ["doing", 1],
      ["done", 2],
      ["cancelled", 1],
    ]);
  });

  it("counts open issues outside done and cancelled stages", () => {
    expect(view.openIssues).toBe(4);
  });

  it("shows zero for stages without issues", () => {
    expect(teamView(team(), {}).stages.every(({ issues }) => issues === 0)).toBe(true);
    expect(teamView(team(), {}).openIssues).toBe(0);
  });
});

describe("team key in the URL", () => {
  const teams = [
    team({ key: "PLAT", former_keys: ["ENG", "OPS"] }),
    team({ id: "team-sec", key: "SEC" }),
  ];

  it("resolves the current key in any case", () => {
    expect(teamForKeyParam(teams, "SEC")?.id).toBe("team-sec");
    expect(teamForKeyParam(teams, "sec")?.id).toBe("team-sec");
  });

  it("resolves an old key to the team, which carries its current key", () => {
    expect(teamForKeyParam(teams, "ENG")?.key).toBe("PLAT");
    expect(teamForKeyParam(teams, "ops")?.key).toBe("PLAT");
  });

  it("finds nothing for an unknown key", () => {
    expect(teamForKeyParam(teams, "NOPE")).toBeUndefined();
  });
});

describe("reordering stages", () => {
  const stages = team().stages;
  const moves = (moved: string, target: string, side: "before" | "after") =>
    reorderStages(stages, moved, target, side).map(({ stage, position }) => [stage.id, position]);

  it("moves a stage up and renumbers the stages it passed", () => {
    expect(moves("doing", "backlog", "before")).toEqual([
      ["doing", 1],
      ["backlog", 2],
      ["todo", 3],
    ]);
  });

  it("moves a stage down", () => {
    expect(moves("backlog", "doing", "after")).toEqual([
      ["todo", 1],
      ["doing", 2],
      ["backlog", 3],
    ]);
  });

  it("changes nothing when a stage is dropped where it already is", () => {
    expect(moves("todo", "doing", "before")).toEqual([]);
    expect(moves("todo", "todo", "after")).toEqual([]);
  });

  it("renumbers gaps from 1", () => {
    const sparse = [stage("a", "backlog", 10), stage("b", "active", 20)];
    expect(
      reorderStages(sparse, "b", "a", "before").map(({ stage, position }) => [stage.id, position]),
    ).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
  });
});

describe("auto-archive choices", () => {
  it("offers the presets and never", () => {
    expect(archiveChoices(30)).toEqual([7, 14, 30, 60, 90, 180, 365, null]);
    expect(archiveChoices(null)).toEqual([7, 14, 30, 60, 90, 180, 365, null]);
  });

  it("keeps a custom value in order", () => {
    expect(archiveChoices(45)).toEqual([7, 14, 30, 45, 60, 90, 180, 365, null]);
    expect(archiveChoices(1000)).toEqual([7, 14, 30, 60, 90, 180, 365, 1000, null]);
  });
});
