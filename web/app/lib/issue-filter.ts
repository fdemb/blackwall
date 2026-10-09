import { ApiError } from "./api";
import type { IssueFilter, Priority } from "./types";
import type { SyncStore, DeepReadonly } from "../sync/store";
import type { SyncIssue } from "../sync/records";
import { parseTimestamp } from "../sync/records";
import { compareCodePoints } from "./order";

const rank: Record<Priority, number> = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };
function nullable<T>(a: T | null, b: T | null, compareValues: (a: T, b: T) => number): number {
  return a === null ? (b === null ? 0 : 1) : b === null ? -1 : compareValues(a, b);
}

// Search words are runs of letters, marks and digits. PostgreSQL's parser also keeps URLs, emails,
// versions and tags whole, so the two disagree on punctuation-heavy text. docs/sync.md notes it.
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((word) => word.toLowerCase());
}

export function matchesSearch(issue: DeepReadonly<SyncIssue>, search: string): boolean {
  if (!search.trim()) return true;
  const text = `${issue.title} ${issue.description}`;
  if (text.toLowerCase().includes(search.toLowerCase())) return true;
  const query = words(search);
  const document = new Set(words(text));
  if (query.length > 0 && query.every((word) => document.has(word))) return true;
  const raw = search.replace(/^#+/, "");
  return (
    /^[1-9]\d*$/.test(raw) &&
    BigInt(raw) <= 9223372036854775807n &&
    issue.number !== null &&
    String(issue.number) === raw
  );
}

type ReplicaIssueFilter = { [Key in keyof IssueFilter]: IssueFilter[Key] | null };

function uuid(value: string): string | undefined {
  let raw = value.startsWith("urn:uuid:") ? value.slice(9) : value;
  if (raw.startsWith("{") && raw.endsWith("}")) raw = raw.slice(1, -1);
  if (/^[\da-f]{32}$/i.test(raw))
    raw = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : undefined;
}

export function filterIssues(
  store: SyncStore,
  filter: ReplicaIssueFilter = {},
): DeepReadonly<SyncIssue>[] {
  if (filter.search && new TextEncoder().encode(filter.search).length > 200)
    throw new ApiError("search query too long", 400);
  let ids: Set<string> | undefined;
  if (filter.ids != null) {
    const values = filter.ids.split(",");
    if (values.some((id) => uuid(id) === undefined))
      throw new ApiError("ids must be comma-separated UUIDs", 400);
    if (values.length > 200) throw new ApiError("ids may contain at most 200 UUIDs", 400);
    ids = new Set(values.flatMap((id) => uuid(id) ?? []));
  }
  const due = filter.due_before == null ? undefined : parseTimestamp(filter.due_before);
  const rows = store.all("issues").filter((issue) => {
    if (
      filter.trash
        ? issue.deleted_at === null
        : issue.deleted_at !== null ||
          (filter.archived ? issue.archived_at === null : issue.archived_at !== null)
    )
      return false;
    for (const column of [
      "assignee",
      "created_by",
      "team_id",
      "stage_id",
      "sprint_id",
      "project_id",
      "parent_id",
      "priority",
    ] as const) {
      const value = filter[column];
      const actual = issue[column];
      if (value != null && (actual === null || (uuid(value) ?? value) !== (uuid(actual) ?? actual)))
        return false;
    }
    if (
      filter.label_id != null &&
      !issue.labels.some((id) => id === (uuid(filter.label_id ?? "") ?? filter.label_id))
    )
      return false;
    if (
      filter.dependency_id != null &&
      !issue.dependencies.some(
        (id) => id === (uuid(filter.dependency_id ?? "") ?? filter.dependency_id),
      )
    )
      return false;
    if (due !== undefined && (issue.deadline === null || issue.deadline > due)) return false;
    if (filter.unassigned && issue.assignee !== null) return false;
    if (filter.no_sprint && issue.sprint_id !== null) return false;
    if (filter.open) {
      const kind = store.stageKind(issue.stage_id);
      if (kind === undefined || kind === "done" || kind === "cancelled") return false;
    }
    if (ids && !ids.has(issue.id)) return false;
    return filter.search == null || matchesSearch(issue, filter.search);
  });
  return rows.sort((a, b) => {
    let group = 0;
    if (filter.group_by === "stage") group = compareCodePoints(a.stage_id, b.stage_id);
    if (filter.group_by === "priority") group = rank[b.priority] - rank[a.priority];
    if (filter.group_by === "assignee") group = nullable(a.assignee, b.assignee, compareCodePoints);
    if (group) return group;
    switch (filter.sort ?? "position") {
      case "deadline":
        return (
          nullable(a.deadline, b.deadline, compareCodePoints) ||
          a.position - b.position ||
          compareCodePoints(a.id, b.id)
        );
      case "updated":
        return compareCodePoints(b.updated_at, a.updated_at) || compareCodePoints(a.id, b.id);
      case "priority":
        return (
          rank[b.priority] - rank[a.priority] ||
          a.position - b.position ||
          compareCodePoints(a.id, b.id)
        );
      case "position":
        return (
          a.position - b.position ||
          nullable(a.number, b.number, (x, y) => x - y) ||
          compareCodePoints(a.id, b.id)
        );
    }
  });
}
