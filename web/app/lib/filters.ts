import type {
  FilterClause,
  FilterField,
  FilterOp,
  FilterValue,
  Id,
  Issue,
  IssueFilter,
  IssueGroup,
  Stage,
  Workspace,
} from "./types";

/** Stage lookup for one workspace. Built once per workspace object, so per-row scans stay O(1). */
const stageIndexCache = new WeakMap<Workspace, Map<Id, Stage>>();

export function stageIndexOf(ws: Workspace): Map<Id, Stage> {
  const hit = stageIndexCache.get(ws);
  if (hit) return hit;
  const index = new Map<Id, Stage>();
  for (const t of ws.teams) for (const s of t.stages) index.set(s.id, s);
  stageIndexCache.set(ws, index);
  return index;
}

export function isDone(ws: Workspace, issue: Issue) {
  const s = stageIndexOf(ws).get(issue.stage_id);
  return s ? s.kind === "done" || s.kind === "cancelled" : false;
}

/** Done exactly: the only stage whose issues auto-archive. Cancelled is excluded. */
export function isDoneOnly(ws: Workspace, issue: Issue) {
  return stageIndexOf(ws).get(issue.stage_id)?.kind === "done";
}

export function stageOf(ws: Workspace, issue: Issue) {
  return stageIndexOf(ws).get(issue.stage_id);
}

export function clause(
  field: FilterField,
  op: FilterOp,
  values: readonly FilterValue[],
): FilterClause {
  return { field, op, values };
}

/** `field is value`, the clause pages use to scope a list. */
export const whereIs = (field: FilterField, ...values: FilterValue[]) =>
  clause(field, "is", values);

/** The open filter: issues whose stage is neither done nor cancelled. */
export const OPEN: FilterClause = clause("stage_kind", "is_not", ["done", "cancelled"]);

export const clausesOf = (filter: IssueFilter): readonly FilterClause[] => filter.where ?? [];

/** The filter with `where` replaced, and dropped when empty so an empty filter stays `{}`. */
export function withClauses(filter: IssueFilter, where: readonly FilterClause[]): IssueFilter {
  const { where: _, ...rest } = filter;
  return where.length ? { ...rest, where } : rest;
}

export function withoutFields(filter: IssueFilter, fields: readonly FilterField[]): IssueFilter {
  return withClauses(
    filter,
    clausesOf(filter).filter((c) => !fields.includes(c.field)),
  );
}

export const addClause = (filter: IssueFilter, next: FilterClause) =>
  withClauses(filter, [...clausesOf(filter), next]);

export const removeClause = (filter: IssueFilter, index: number) =>
  withClauses(
    filter,
    clausesOf(filter).filter((_, i) => i !== index),
  );

export const replaceClause = (filter: IssueFilter, index: number, next: FilterClause) =>
  withClauses(
    filter,
    clausesOf(filter).map((c, i) => (i === index ? next : c)),
  );

/**
 * What a queue really shows: the person's filters plus the scope the page adds (team, assignee).
 * A person's clause on a scoped field gives way to the scope's.
 */
export function effectiveFilter(
  filter: IssueFilter,
  scope: IssueFilter = {},
  groupBy?: IssueGroup,
): IssueFilter {
  const scoped = clausesOf(scope);
  const own = clausesOf(filter).filter((c) => !scoped.some((s) => s.field === c.field));
  const merged = withClauses({ ...filter, ...scope, trash: false }, [...own, ...scoped]);
  if (groupBy) merged.group_by = groupBy;
  return merged;
}

/** Whether the person narrowed the list beyond the page's own scope, so "no match" is right. */
export function isNarrowed(filter: IssueFilter, hidden: readonly string[] = []): boolean {
  if (clausesOf(filter).some((c) => !hidden.includes(c.field))) return true;
  if (filter.search) return true;
  return Boolean(filter.archived) && !hidden.includes("archived");
}

/** The one value an `is` clause pins a field to, for defaults such as a new issue's team. */
export function pinnedValue(filter: IssueFilter, field: FilterField): string | undefined {
  const pins = clausesOf(filter).filter((c) => c.field === field && c.op === "is");
  const first = pins[0]?.values[0];
  return pins.length === 1 && pins[0]!.values.length === 1 && first != null ? first : undefined;
}

const normalizedClause = (c: FilterClause) => JSON.stringify([c.field, c.op, [...c.values].sort()]);
const normalized = (f: IssueFilter) =>
  JSON.stringify(
    Object.entries({
      ...f,
      sort: f.sort ?? "position",
      group_by: f.group_by ?? "stage",
      where: clausesOf(f).map(normalizedClause).sort(),
    })
      // The server sends unset filters as null, the UI leaves them out. Treat both as unset.
      .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
      .filter(([, v]) => !(Array.isArray(v) && v.length === 0))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
export const sameFilter = (a: IssueFilter, b: IssueFilter) => normalized(a) === normalized(b);

/** A relative date value: "+7d", "-30d", "+0d". */
export const relativeDay = (days: number) => `${days < 0 ? "" : "+"}${days}d`;
