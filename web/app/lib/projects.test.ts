import { describe, expect, it } from "vite-plus/test";
import { milestoneGroups, projectMilestones } from "./projects";
import type { Milestone } from "./types";

const milestone = (id: string, project_id: string, deadline: string | null): Milestone => ({
  id,
  version: 1,
  project_id,
  name: id,
  deadline,
});

describe("milestone grouping", () => {
  const milestones = [
    milestone("open", "p", null),
    milestone("late", "p", "2026-12-01T12:00:00.000Z"),
    milestone("other", "q", "2026-01-01T12:00:00.000Z"),
    milestone("soon", "p", "2026-11-01T12:00:00.000Z"),
    milestone("empty", "p", "2026-11-15T12:00:00.000Z"),
  ];
  const issue = (id: string, milestone_id: string | null) => ({ id, milestone_id });

  it("orders a project's milestones by deadline, those without one last", () => {
    expect(projectMilestones(milestones, "p").map((m) => m.id)).toEqual([
      "soon",
      "empty",
      "late",
      "open",
    ]);
  });

  it("groups issues in milestone order, ends with no milestone and drops empty milestones", () => {
    const issues = [
      issue("a", null),
      issue("b", "late"),
      issue("c", "soon"),
      issue("d", "open"),
      issue("e", "soon"),
    ];
    const groups = milestoneGroups(issues, projectMilestones(milestones, "p"));
    expect(groups.map((g) => [g.milestone?.id ?? null, g.items.map((i) => i.id)])).toEqual([
      ["soon", ["c", "e"]],
      ["late", ["b"]],
      ["open", ["d"]],
      [null, ["a"]],
    ]);
  });
});
