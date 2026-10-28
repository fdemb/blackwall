import type { TFunction } from "i18next";
import { ISSUE_FIELDS } from "~/lib/issue-fields";
import { shortDate } from "~/lib/format";
import type { FieldChange, Id } from "~/lib/types";

type Reference = "team" | "stage" | "assignee" | "project" | "milestone" | "sprint" | "parent";

/** Current names from the replica. Undefined means the record no longer exists. */
export type ChangeNames = Record<Reference | "labels", (id: Id) => string | undefined>;

interface Context {
  t: TFunction;
  lang: string;
  names: ChangeNames;
}

/**
 * Phrases for an update, such as "changed status from Todo to Done". Fields without stored
 * values, from older rows or the description, share one "changed …" phrase.
 */
export function describeChanges(
  fields: readonly string[],
  changes: readonly FieldChange[],
  context: Context,
): string[] {
  const { t, lang } = context;
  const phrases: string[] = [];
  const plain: string[] = [];
  for (const field of fields) {
    const change = changes.find((c) => c.field === field);
    const phrase = change && describeChange(change, context);
    if (phrase) phrases.push(phrase);
    else if (ISSUE_FIELDS[field]) plain.push(t(ISSUE_FIELDS[field].label).toLocaleLowerCase(lang));
  }
  if (plain.length) phrases.push(t("timeline.changed", { fields: plain.join(", ") }));
  return phrases;
}

function describeChange(change: FieldChange, context: Context): string | undefined {
  const { t, lang, names } = context;
  if (!("from" in change)) return undefined;
  if (change.field === "labels") {
    const list = (ids: readonly Id[]) =>
      ids.map((id) => names.labels(id) ?? t("timeline.deleted")).join(", ");
    const added = change.to.filter((id) => !change.from.includes(id));
    const removed = change.from.filter((id) => !change.to.includes(id));
    return [
      added.length ? t("timeline.labelsAdded", { count: added.length, labels: list(added) }) : "",
      removed.length
        ? t("timeline.labelsRemoved", { count: removed.length, labels: list(removed) })
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  const [from, to] = values(change, context);
  const label = ISSUE_FIELDS[change.field]?.label;
  const field = label ? t(label).toLocaleLowerCase(lang) : change.field;
  if (from !== null && to !== null) return t("timeline.changedValue", { field, from, to });
  if (to !== null) return t("timeline.set", { field, to });
  if (from !== null) return t("timeline.cleared", { field, from });
  return undefined;
}

type Valued = Exclude<FieldChange, { field: "labels" | "description" | "dependencies" }>;

function values(change: Valued, { t, lang, names }: Context): [string | null, string | null] {
  const both = <T>(
    text: (value: T) => string,
    from: T | null,
    to: T | null,
  ): [string | null, string | null] => [
    from === null ? null : text(from),
    to === null ? null : text(to),
  ];
  switch (change.field) {
    case "title":
      return both((text) => t("timeline.quoted", { text }), change.from, change.to);
    case "priority":
      return both((priority) => t(`priority.${priority}`), change.from, change.to);
    case "estimate":
      return both((points) => `${points} ${t("estimate.unit")}`, change.from, change.to);
    case "deadline":
      return both((iso) => shortDate(iso, lang), change.from, change.to);
    default: {
      const name = names[change.field];
      return both((id) => name(id) ?? t("timeline.deleted"), change.from, change.to);
    }
  }
}
