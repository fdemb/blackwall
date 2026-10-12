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

// Lowercases one code point at a time. Whole-string toLowerCase() turns a word-final Σ into ς, and
// PostgreSQL keeps σ, so "ΟΣ" would miss "ΟΣΟ".
function lowercase(text: string): string {
  return Array.from(text, (char) => char.toLowerCase()).join("");
}

function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((word) => lowercase(word));
}

function searchPredicate(search: string): (issue: DeepReadonly<SyncIssue>) => boolean {
  if (!search.trim()) return () => true;
  const substring = lowercase(search);
  const query = words(search);
  const raw = search.replace(/^#+/, "");
  const number = /^[1-9]\d*$/.test(raw) && BigInt(raw) <= 9223372036854775807n ? raw : undefined;
  return (issue) => {
    const text = `${issue.title} ${issue.description}`;
    if (lowercase(text).includes(substring)) return true;
    const document = new Set(words(text));
    if (query.length > 0 && query.every((word) => document.has(word))) return true;
    return issue.number !== null && String(issue.number) === number;
  };
}

export function matchesSearch(issue: DeepReadonly<SyncIssue>, search: string): boolean {
  return searchPredicate(search)(issue);
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
  const ids = filter.ids == null ? undefined : parseIds(filter.ids);
  const due = filter.due_before == null ? undefined : parseTimestamp(filter.due_before);
  const equality = (
    [
      "assignee",
      "created_by",
      "team_id",
      "stage_id",
      "sprint_id",
      "project_id",
      "parent_id",
      "priority",
    ] as const
  ).flatMap((column) => {
    const value = filter[column];
    return value == null ? [] : [[column, uuid(value) ?? value] as const];
  });
  const label = filter.label_id == null ? undefined : (uuid(filter.label_id) ?? filter.label_id);
  const dependency =
    filter.dependency_id == null ? undefined : (uuid(filter.dependency_id) ?? filter.dependency_id);
  const matches = searchPredicate(filter.search ?? "");
  const isOpen = (issue: DeepReadonly<SyncIssue>) => {
    const kind = store.stageKind(issue.stage_id);
    return kind !== undefined && kind !== "done" && kind !== "cancelled";
  };
  const rows = store.all("issues").filter((issue) => {
    if (!inLifecycle(filter, issue)) return false;
    for (const [column, value] of equality) {
      const actual = issue[column];
      if (actual === null || (uuid(actual) ?? actual) !== value) return false;
    }
    if (label !== undefined && !issue.labels.includes(label)) return false;
    if (dependency !== undefined && !issue.dependencies.includes(dependency)) return false;
    if (due !== undefined && (issue.deadline === null || issue.deadline > due)) return false;
    if (filter.unassigned && issue.assignee !== null) return false;
    if (filter.no_sprint && issue.sprint_id !== null) return false;
    if (filter.open && !isOpen(issue)) return false;
    if (ids && !ids.has(issue.id)) return false;
    return matches(issue);
  });
  return rows.sort((a, b) => compareGroup(filter, a, b) || compareSort(filter, a, b));
}

function parseIds(list: string): Set<string> {
  const values = list.split(",").map(uuid);
  if (values.some((id) => id === undefined))
    throw new ApiError("ids must be comma-separated UUIDs", 400);
  if (values.length > 200) throw new ApiError("ids may contain at most 200 UUIDs", 400);
  return new Set(values.filter((id) => id !== undefined));
}

/** Trash shows only deleted issues; otherwise live issues, archived or not per the filter. */
function inLifecycle(filter: ReplicaIssueFilter, issue: DeepReadonly<SyncIssue>): boolean {
  if (filter.trash) return issue.deleted_at !== null;
  return issue.deleted_at === null && (issue.archived_at !== null) === Boolean(filter.archived);
}

type Row = DeepReadonly<SyncIssue>;

function compareGroup(filter: ReplicaIssueFilter, a: Row, b: Row): number {
  switch (filter.group_by) {
    case "stage":
      return compareCodePoints(a.stage_id, b.stage_id);
    case "priority":
      return rank[b.priority] - rank[a.priority];
    case "assignee":
      return nullable(a.assignee, b.assignee, compareCodePoints);
    default:
      return 0;
  }
}

function compareSort(filter: ReplicaIssueFilter, a: Row, b: Row): number {
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
}
