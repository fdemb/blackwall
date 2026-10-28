import { describe, expect, it } from "vite-plus/test";
import { describeChanges, type ChangeNames } from "./activity-changes";
import { createI18n } from "./i18n-instance";
import type { FieldChange, Language } from "./types";

const records: Record<string, string> = {
  todo: "Todo",
  doing: "In progress",
  ann: "Ann",
  bug: "Bug",
  ui: "UI",
};
const lookup = (id: string) => records[id];
const names: ChangeNames = {
  team: lookup,
  stage: lookup,
  assignee: lookup,
  labels: lookup,
  project: lookup,
  milestone: lookup,
  sprint: lookup,
  parent: lookup,
};

function phrases(fields: string[], changes: FieldChange[], lang: Language = "en"): string[] {
  return describeChanges(fields, changes, { t: createI18n(lang).t, lang, names });
}

describe("describeChanges", () => {
  it("names both stages of a stage change", () => {
    expect(phrases(["stage"], [{ field: "stage", from: "todo", to: "doing" }])).toEqual([
      "changed status from Todo to In progress",
    ]);
  });

  it("shows a placeholder for a deleted stage", () => {
    expect(phrases(["stage"], [{ field: "stage", from: "gone", to: "doing" }])).toEqual([
      "changed status from (deleted) to In progress",
    ]);
  });

  it("says set and removed for empty values", () => {
    expect(
      phrases(
        ["assignee", "project"],
        [
          { field: "assignee", from: null, to: "ann" },
          { field: "project", from: "gone", to: null },
        ],
      ),
    ).toEqual(["set assignee to Ann", "removed project (deleted)"]);
  });

  it("lists added and removed labels instead of both sets", () => {
    expect(
      phrases(["labels"], [{ field: "labels", from: ["bug", "ui"], to: ["ui", "new"] }]),
    ).toEqual(["added label (deleted), removed label Bug"]);
  });

  it("keeps fields without values in one changed phrase", () => {
    expect(
      phrases(
        ["description", "priority", "estimate"],
        [{ field: "description" }, { field: "priority", from: "low", to: "urgent" }],
      ),
    ).toEqual(["changed priority from Low to Urgent", "changed description, estimate"]);
  });

  it("renders a stage change in Polish", () => {
    expect(phrases(["stage"], [{ field: "stage", from: "todo", to: "doing" }], "pl")).toEqual([
      "zmieniono: status (Todo → In progress)",
    ]);
  });
});
