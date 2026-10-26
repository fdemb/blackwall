import { ApiError } from "./api";
import { parseIssueKey } from "./identifiers";
import { teamByKey } from "./teams";
import type {
  FilterClause,
  FilterField,
  FilterOp,
  IssueFilter,
  Priority,
  StageKind,
} from "./types";
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
// PostgreSQL keeps σ, so "ΟΣ" would miss "ΟΣΟ". Final sigma is the only context-dependent mapping,
// so text without Σ takes the whole-string path.
function lowercase(text: string): string {
  if (!text.includes("Σ")) return text.toLowerCase();
  return Array.from(text, (char) => char.toLowerCase()).join("");
}

function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((word) => lowercase(word));
}

// Store records are frozen and replaced on change, so the record itself keys its search text.
interface Searchable {
  text: string;
  words?: Set<string>;
}
const searchables = new WeakMap<DeepReadonly<SyncIssue>, Searchable>();
function searchable(issue: DeepReadonly<SyncIssue>): Searchable {
  let entry = searchables.get(issue);
  if (!entry) {
    entry = { text: lowercase(`${issue.title} ${issue.description}`) };
    searchables.set(issue, entry);
  }
  return entry;
}

/**
 * Text, words, an issue number, or a key such as `ENG-42`, which `teamOf` maps to its team id as
 * the server's `issue_number_search` does.
 */
function searchPredicate(
  search: string,
  teamOf: (key: string) => string | undefined = () => undefined,
): (issue: DeepReadonly<SyncIssue>) => boolean {
  if (!search.trim()) return () => true;
  const substring = lowercase(search);
  const query = words(search);
  const key = parseIssueKey(search.trim());
  const keyTeam = key ? teamOf(key.team) : undefined;
  const raw = key ? String(key.number) : search.replace(/^#+/, "");
  const number = /^[1-9]\d*$/.test(raw) && BigInt(raw) <= 9223372036854775807n ? raw : undefined;
  return (issue) => {
    const entry = searchable(issue);
    if (entry.text.includes(substring)) return true;
    if (query.length > 0) {
      entry.words ??= new Set(words(`${issue.title} ${issue.description}`));
      const document = entry.words;
      if (query.every((word) => document.has(word))) return true;
    }
    if (number === undefined) return false;
    if (String(issue.number) === number && (!key || issue.team_id === keyTeam)) return true;
    return (
      keyTeam !== undefined &&
      issue.former_keys.some((k) => k.team_id === keyTeam && String(k.number) === number)
    );
  };
}

export function matchesSearch(
  issue: DeepReadonly<SyncIssue>,
  search: string,
  teamOf?: (key: string) => string | undefined,
): boolean {
  return searchPredicate(search, teamOf)(issue);
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

// Clause rules from src/domain/filter.rs, with its error messages. docs/filters.md explains them.

export const MAX_CLAUSES = 32;
export const MAX_VALUES = 200;

type Kind = "id" | "stage_kind" | "priority" | "number" | "time";
export const FIELD_KIND: Record<FilterField, Kind> = {
  assignee: "id",
  created_by: "id",
  team_id: "id",
  stage_id: "id",
  stage_kind: "stage_kind",
  priority: "priority",
  labels: "id",
  project_id: "id",
  sprint_id: "id",
  parent_id: "id",
  dependencies: "id",
  estimate: "number",
  deadline: "time",
  created_at: "time",
  updated_at: "time",
};
/** Fields that can be empty, so null is a meaningful value. */
export const NULLABLE_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>([
  "assignee",
  "created_by",
  "labels",
  "project_id",
  "sprint_id",
  "parent_id",
  "dependencies",
  "estimate",
  "deadline",
]);
const PRIORITIES = new Set<string>(Object.keys(rank));
const STAGE_KINDS = new Set<string>(["backlog", "planned", "active", "done", "cancelled"]);
const COMPARISONS: ReadonlySet<FilterOp> = new Set<FilterOp>(["lt", "lte", "gt", "gte"]);

export const isComparison = (op: FilterOp) => COMPARISONS.has(op);
export const isOrdered = (field: FilterField) =>
  FIELD_KIND[field] === "priority" ||
  FIELD_KIND[field] === "number" ||
  FIELD_KIND[field] === "time";

/** Ops a field accepts, in menu order. */
export function opsFor(field: FilterField): FilterOp[] {
  return isOrdered(field) ? ["is", "is_not", "lt", "lte", "gt", "gte"] : ["is", "is_not"];
}

const RELATIVE_DAY = /^([+-]?)(\d{1,5})d$/;

/** The signed day count of a relative date value such as "+7d", or undefined for a timestamp. */
export function relativeDays(value: string): number | undefined {
  const match = RELATIVE_DAY.exec(value);
  if (!match) return undefined;
  const days = Number(match[2]);
  return match[1] === "-" ? -days : days;
}

/** End of the local day `days` from today, as the replica stores timestamps. */
export function endOfDay(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 59, 999);
  return parseTimestamp(d.toISOString());
}

function parseTime(value: string, now: Date): string | undefined {
  const days = relativeDays(value);
  if (days !== undefined) return endOfDay(days, now);
  let normalized: string;
  try {
    normalized = parseTimestamp(value, true);
  } catch {
    return undefined;
  }
  const year = Number(/^([+-]?\d+)-/.exec(normalized)?.[1]);
  return year >= 1 && year <= 9999 ? normalized : undefined;
}

function parseEstimate(value: string): number | undefined {
  if (!/^\d{1,10}$/.test(value)) return undefined;
  const number = Number(value);
  return number <= 4294967295 ? number : undefined;
}

function bad(message: string): ApiError {
  return new ApiError(message, 400);
}

/** One clause with its values parsed. A comparison holds one value and no null. */
export interface CompiledClause {
  field: FilterField;
  op: FilterOp;
  kind: Kind;
  /** Parsed values: lowercased UUIDs, priority ranks, estimates or canonical timestamps. */
  values: readonly (string | number)[];
  null: boolean;
}

export function compileClause(clause: FilterClause, now = new Date()): CompiledClause {
  const { field, op } = clause;
  const kind = FIELD_KIND[field];
  if (kind === undefined) throw bad(`unknown filter field ${JSON.stringify(field)}`);
  if (!opsFor(field).includes(op)) {
    if (!COMPARISONS.has(op) && op !== "is" && op !== "is_not")
      throw bad(`unknown filter op ${JSON.stringify(op)}`);
    throw bad(`filter op ${op} does not apply to ${field}`);
  }
  const raw = clause.values;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_VALUES)
    throw bad(`filter clause needs 1 to ${MAX_VALUES} values`);
  const hasNull = raw.some((value) => value === null);
  if (isComparison(op) && (hasNull || raw.length !== 1))
    throw bad("filter comparison takes one non-null value");
  if (hasNull && !NULLABLE_FIELDS.has(field))
    throw bad(`filter value null does not apply to ${field}`);
  const values = raw.flatMap((value) => {
    if (value === null) return [];
    if (typeof value !== "string")
      throw bad(`filter value ${JSON.stringify(value)} is not valid for ${field}`);
    const parsed = parseValue(kind, value, now);
    if (parsed === undefined)
      throw bad(`filter value ${JSON.stringify(value)} is not valid for ${field}`);
    return [parsed];
  });
  return { field, op, kind, values, null: hasNull };
}

function parseValue(kind: Kind, value: string, now: Date): string | number | undefined {
  switch (kind) {
    case "id":
      return uuid(value);
    case "stage_kind":
      return STAGE_KINDS.has(value) ? value : undefined;
    case "priority":
      return PRIORITIES.has(value) ? rank[value as Priority] : undefined;
    case "number":
      return parseEstimate(value);
    case "time":
      return parseTime(value, now);
  }
}

/** Validates and parses a `where` list. Throws the server's 400 message on a bad clause. */
export function compileFilter(
  where: readonly FilterClause[] | null | undefined,
  now = new Date(),
): CompiledClause[] {
  const clauses = where ?? [];
  if (clauses.length > MAX_CLAUSES) throw bad(`filter has at most ${MAX_CLAUSES} clauses`);
  return clauses.map((clause) => compileClause(clause, now));
}

type Row = DeepReadonly<SyncIssue>;

function member<T>(actual: T | null, wanted: readonly T[], hasNull: boolean): boolean {
  return actual === null ? hasNull : wanted.includes(actual);
}

function overlaps(
  actual: readonly string[],
  wanted: readonly (string | number)[],
  hasNull: boolean,
) {
  if (actual.length === 0) return hasNull;
  return actual.some((item) => wanted.includes(canonical(item)));
}

function ordered<T extends string | number>(actual: T | null, bound: T, op: FilterOp): boolean {
  if (actual === null) return false;
  switch (op) {
    case "lt":
      return actual < bound;
    case "lte":
      return actual <= bound;
    case "gt":
      return actual > bound;
    case "gte":
      return actual >= bound;
    case "is":
      return actual === bound;
    case "is_not":
      return actual !== bound;
  }
}

function test<T extends string | number>(
  clause: CompiledClause,
  actual: T | null,
  wanted: readonly T[],
): boolean {
  return isComparison(clause.op)
    ? ordered(actual, wanted[0]!, clause.op)
    : member(actual, wanted, clause.null);
}

// Every list query canonicalizes the id fields of every issue, so the parsed spellings are kept.
// Distinct ids are bounded by the replica; the cap only guards against unbounded growth.
const canonicalIds = new Map<string, string>();
function canonical(value: string): string {
  let parsed = canonicalIds.get(value);
  if (parsed === undefined) {
    if (canonicalIds.size >= 100_000) canonicalIds.clear();
    parsed = uuid(value) ?? value;
    canonicalIds.set(value, parsed);
  }
  return parsed;
}

const id = (value: string | null) => (value === null ? null : canonical(value));

export function matchesClause(
  clause: CompiledClause,
  issue: Row,
  kindOf: (stageId: string) => StageKind | undefined,
): boolean {
  let hit: boolean;
  const values = clause.values;
  switch (clause.field) {
    case "assignee":
      hit = member(id(issue.assignee), values, clause.null);
      break;
    case "created_by":
      hit = member(id(issue.created_by), values, clause.null);
      break;
    case "team_id":
      hit = member(id(issue.team_id), values, clause.null);
      break;
    case "stage_id":
      hit = member(id(issue.stage_id), values, clause.null);
      break;
    case "project_id":
      hit = member(id(issue.project_id), values, clause.null);
      break;
    case "sprint_id":
      hit = member(id(issue.sprint_id), values, clause.null);
      break;
    case "parent_id":
      hit = member(id(issue.parent_id), values, clause.null);
      break;
    case "labels":
      hit = overlaps(issue.labels, values, clause.null);
      break;
    case "dependencies":
      hit = overlaps(issue.dependencies, values, clause.null);
      break;
    case "stage_kind":
      hit = member(kindOf(issue.stage_id) ?? null, values, false);
      break;
    case "priority":
      hit = test(clause, rank[issue.priority], values as number[]);
      break;
    case "estimate":
      hit = test(clause, issue.estimate, values as number[]);
      break;
    case "deadline":
      hit = test(clause, issue.deadline, values as string[]);
      break;
    case "created_at":
      hit = test(clause, issue.created_at, values as string[]);
      break;
    case "updated_at":
      hit = test(clause, issue.updated_at, values as string[]);
      break;
  }
  return clause.op === "is_not" ? !hit : hit;
}

/** Matching issues in display order. With `limit`, only the first `limit` of them. */
export function filterIssues(
  store: SyncStore,
  filter: ReplicaIssueFilter = {},
  limit?: number,
): DeepReadonly<SyncIssue>[] {
  if (filter.search && new TextEncoder().encode(filter.search).length > 200)
    throw new ApiError("search query too long", 400);
  const ids = filter.ids == null ? undefined : parseIds(filter.ids);
  const clauses = compileFilter(filter.where);
  const matches = searchPredicate(
    filter.search ?? "",
    (key) => teamByKey(store.all("teams"), key)?.id,
  );
  const kindOf = (stageId: string) => store.stageKind(stageId);
  const rows = candidates(store, ids, clauses).filter((issue) => {
    if (!inLifecycle(filter, issue)) return false;
    for (const clause of clauses) if (!matchesClause(clause, issue, kindOf)) return false;
    return matches(issue);
  });
  return first(rows, comparator(filter), limit);
}

/**
 * Rows that can match: the `ids` list by key, else the smallest index lookup an `is` clause
 * allows, else the whole table.
 */
function candidates(
  store: SyncStore,
  ids: Set<string> | undefined,
  clauses: readonly CompiledClause[],
): readonly Row[] {
  if (ids) return [...ids].flatMap((key) => store.get("issues", key) ?? []);
  let best: readonly Row[] | undefined;
  for (const clause of clauses) {
    const rows = indexed(store, clause);
    if (rows && (!best || rows.length < best.length)) best = rows;
  }
  return best ?? store.all("issues");
}

// Clause fields backed by a store index of the same name. The index keys raw values, so this
// relies on the replica holding canonical ids: the server sends PostgreSQL uuids, and mutators
// only store team, stage, sprint, project and parent ids they found by key.
type IndexedField = "team_id" | "stage_id" | "sprint_id" | "project_id" | "parent_id";
const INDEXED = new Set<FilterField>([
  "team_id",
  "stage_id",
  "sprint_id",
  "project_id",
  "parent_id",
]);

function indexed(store: SyncStore, clause: CompiledClause): readonly Row[] | undefined {
  if (clause.op !== "is" || !INDEXED.has(clause.field)) return undefined;
  const values = new Set<string | null>(clause.values as string[]);
  if (clause.null) values.add(null);
  const field = clause.field as IndexedField;
  return [...values].flatMap((value) => store.byIndex("issues", field, value));
}

/** The first `limit` rows in order. Keeps a sorted window instead of sorting every match. */
function first(rows: Row[], compare: Compare, limit?: number): Row[] {
  if (limit === undefined || limit < 1 || rows.length <= limit) return rows.sort(compare);
  const top: Row[] = [];
  for (const row of rows) {
    if (top.length >= limit && compare(row, top[top.length - 1]!) >= 0) continue;
    top.splice(insertionPoint(top, row, compare), 0, row);
    if (top.length > limit) top.pop();
  }
  return top;
}

function insertionPoint(sorted: Row[], row: Row, compare: Compare): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(sorted[middle]!, row) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
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

type Compare = (a: Row, b: Row) => number;

// Stored timestamps are canonical ASCII, where UTF-16 order is code point order.
const compareTimes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const GROUPS = new Map<string, Compare>([
  ["stage", (a, b) => compareCodePoints(a.stage_id, b.stage_id)],
  ["priority", (a, b) => rank[b.priority] - rank[a.priority]],
  ["assignee", (a, b) => nullable(a.assignee, b.assignee, compareCodePoints)],
]);

const SORTS = new Map<string, Compare>([
  [
    "deadline",
    (a, b) =>
      nullable(a.deadline, b.deadline, compareTimes) ||
      a.position - b.position ||
      compareCodePoints(a.id, b.id),
  ],
  ["updated", (a, b) => compareTimes(b.updated_at, a.updated_at) || compareCodePoints(a.id, b.id)],
  [
    "priority",
    (a, b) =>
      rank[b.priority] - rank[a.priority] ||
      a.position - b.position ||
      compareCodePoints(a.id, b.id),
  ],
  [
    "position",
    (a, b) => a.position - b.position || a.number - b.number || compareCodePoints(a.id, b.id),
  ],
]);

const unordered: Compare = () => 0;

/** Display order: the group first, then the sort. Picked once per query, not per comparison. */
function comparator(filter: ReplicaIssueFilter): Compare {
  const sort = SORTS.get(filter.sort ?? "position") ?? unordered;
  const group = GROUPS.get(filter.group_by ?? "none");
  return group ? (a, b) => group(a, b) || sort(a, b) : sort;
}
